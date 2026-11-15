import { spawn } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProcessRunner,
  wslCommand,
  type Runner,
} from "../../../../tools/coordinator/process-runner.ts";
import { readWorkers } from "../../../../tools/coordinator/wsl-workers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("worker stdout log reader", () => {
  it.skipIf(process.platform === "win32")(
    "resolves each pid's fd 1, counts the full log and tolerates a vanished pid",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "omi-worker-"));
      dirs.push(dir);
      const file = join(dir, "omi-064-codex-team-profile-20261111-120000.jsonl");
      const lines = [
        JSON.stringify({ type: "turn.started" }),
        ...Array.from({ length: 1500 }, () =>
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "command_execution",
              command: "npm run check",
              aggregated_output: "x".repeat(1000),
            },
          }),
        ),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Checks passed" },
        }),
        JSON.stringify({ type: "turn.completed" }),
      ];
      await writeFile(file, lines.join("\n") + '\n{"type":');
      const fd = await open(file, "a");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["ignore", fd.fd, "ignore"],
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        let calls = 0;
        const realRun = createProcessRunner();
        const run: Runner = (command) => {
          calls++;
          if (calls === 1)
            return Promise.resolve({
              code: 0,
              stderr: "",
              stdout: `@@ps\n${String(child.pid)} 65 codex exec --json -m gpt-6.1-sol -c model_reasoning_effort=high\n2147483647 1 claude -p\n@@log\n`,
            });
          // Verify the emitted payload is acceptable to the Windows quoting guard too.
          wslCommand(command.args.at(-1) ?? "", { viaWslExe: true, distro: "test", repoDir: dir });
          return realRun(command);
        };
        const report = await readWorkers(run, { viaWslExe: false, distro: "unused", repoDir: dir });
        expect(report.available).toBe(true);
        if (!report.available) return;
        expect(report.processes[0]).toMatchObject({
          task: "OMI-064",
          profile: "team-profile",
          model: "gpt-6.1-sol",
          effort: "high",
          log: { numTurns: 1, lastAction: "Checks passed", finished: true, isError: false },
        });
        expect(report.processes[1]).toMatchObject({ task: null, profile: null, log: null });
        expect(JSON.stringify(report)).not.toContain("aggregated_output");
      } finally {
        child.kill();
        await new Promise<void>((resolve) => {
          child.once("close", () => {
            resolve();
          });
        });
        await fd.close();
      }
    },
  );
});
