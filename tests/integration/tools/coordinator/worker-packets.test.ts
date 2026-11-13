import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, open, rm, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QUOTA_SETTINGS } from "../../../../tools/coordinator/coordinator-settings.ts";
import { createProcessRunner, type Runner } from "../../../../tools/coordinator/process-runner.ts";
import { buildSnapshot } from "../../../../tools/coordinator/watch-snapshot.ts";
import { readPrompts, type TasksRead } from "../../../../tools/coordinator/watch-tasks.ts";
import { loadTemplate } from "../../../../tools/coordinator/watch-workflow.ts";
import { readWorkers } from "../../../../tools/coordinator/wsl-workers.ts";

const dirs: string[] = [];
const children: ChildProcess[] = [];
const handles: FileHandle[] = [];
const home = process.env.HOME;
afterEach(async () => {
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  for (const child of children.splice(0)) child.kill();
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const header = (step: string, role: string) => `# Workflow feature · step ${step} · role ${role}\n`;
const packet = (step: string, role: string, skill: string) =>
  `${header(step, role)}## Skill: ${skill}\n## Rule: project-baseline (mandatory)\n`;

describe("collector to snapshot: each running worker shows its own packet", () => {
  it.skipIf(process.platform === "win32")(
    "with 17 retained resumes of one step and an older parallel worker, nothing leaks between cards",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "omi-packets-"));
      dirs.push(root);
      const runs = join(root, "omi-runs");
      await mkdir(runs);
      const at = (seconds: number) => new Date(Date.now() - seconds * 1000);
      const put = async (name: string, text: string, ageSeconds: number) => {
        await writeFile(join(runs, name), text);
        await utimes(join(runs, name), at(ageSeconds), at(ageSeconds));
      };

      const full = "omi-004-prompt-implement-1-aaa111.md";
      await put(full, packet("implement", "developer", "minimal-change"), 5000);
      // 17 resumes of the same step and round: the newest is the one the worker reads
      for (let i = 1; i <= 17; i++) {
        const name = `omi-004-resume-implement-1-r${String(i).padStart(2, "0")}.md`;
        await put(name, `# Native resume only\n## Skill: receiving-code-review\n`, 4000 - i * 10);
      }
      const newestResume = "omi-004-resume-implement-1-r17.md";
      const verify = "omi-004-prompt-verify-1-bbb222.md";
      await put(verify, packet("verify", "qa", "qa-verification"), 3000);
      // a later full packet of ANOTHER round must never be merged into the resume
      await put(
        "omi-004-prompt-implement-2-ccc333.md",
        packet("implement", "developer", "other-round"),
        10,
      );

      const spawnWorker = async (stdin: string | null, log: string) => {
        const input = stdin === null ? null : await open(join(runs, stdin), "r");
        const output = await open(join(runs, log), "a");
        if (input) handles.push(input);
        handles.push(output);
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: [input?.fd ?? "ignore", output.fd, "ignore"],
        });
        children.push(child);
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        return child.pid;
      };
      const resumed = await spawnWorker(newestResume, "omi-004-test-20261113-100000.jsonl");
      const older = await spawnWorker(verify, "omi-004-test-20261113-090000.jsonl");
      const unknown = await spawnWorker(null, "omi-004-test-20261113-080000.jsonl");

      process.env.HOME = root;
      const realRun = createProcessRunner();
      let calls = 0;
      const run: Runner = (command) => {
        calls++;
        if (calls === 1)
          return Promise.resolve({
            code: 0,
            stderr: "",
            stdout: `@@ps\n${[
              [resumed, 30],
              [older, 20],
              [unknown, 10],
            ]
              .map(([pid, age]) => `${String(pid)} ${String(age)} claude -p`)
              .join("\n")}\n@@log\n`,
          });
        return realRun(command);
      };
      const target = { viaWslExe: false, distro: "unused", repoDir: root };
      const workers = await readWorkers(run, target);
      expect(workers.available && workers.processes.map((p) => p.packet)).toEqual([
        newestResume,
        verify,
        null,
      ]);

      const prompts = await readPrompts(
        realRun,
        target,
        ["OMI-004"],
        workers.available ? workers.processes.flatMap((p) => (p.packet ? [p.packet] : [])) : [],
      );
      expect(prompts).not.toBeNull();
      const tasks: TasksRead = {
        available: true,
        items: [
          {
            kind: "Issue",
            number: 100,
            title: "[OMI-004] t",
            state: "OPEN",
            status: "In Progress",
            priority: "P1",
            workType: "Task",
            planKey: "OMI-004",
            body: "",
            workflow: "feature",
            role: "Developer",
            area: null,
            milestone: null,
            blockers: [],
            blockersTruncated: false,
          },
        ],
        pulls: [],
        prompts: prompts ?? {},
        templates: { feature: await loadTemplate("feature") },
      };
      const snapshot = buildSnapshot({
        workers,
        tasks,
        quota: null,
        now: Date.now() / 1000,
        settings: QUOTA_SETTINGS,
        profiles: [],
      });

      expect(snapshot.tasks).toHaveLength(3);
      const byStep = (step: string | undefined) => snapshot.tasks.find((c) => c.who?.step === step);
      // the newest of 17 resumes merges the original full packet of the SAME step and round
      expect(byStep("implement")?.loaded?.skills).toEqual([
        "minimal-change",
        "receiving-code-review",
      ]);
      expect(byStep("verify")?.loaded?.skills).toEqual(["qa-verification"]);
      // a worker whose packet is unknown shows nothing, never another worker's skills or rules
      const none = snapshot.tasks.find((c) => c.who?.step === null);
      expect(none?.loaded).toBeNull();
      expect(none?.notes.join(" ")).toContain("packet unknown");
      expect(none?.skillCheck).toBeNull();
      expect(none?.who?.step).toBeNull();
      expect(new Set(snapshot.tasks.map((c) => c.runId)).size).toBe(3);
    },
    30_000,
  );
});
