import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { buildClaudeCodeEnvironment } from "../executors/claude-code/claude-code-environment.js";
import { buildCodexEnvironment } from "../executors/codex/codex-environment.js";
import { runWorkerUnderOwner } from "./owned-worker-run.js";
import { startIdentity } from "./worker-recovery.js";
import { repositoryWorkerArgs, type RepositoryWorkerSpec } from "./repository-worker-invocation.js";

export async function runDockerWorker(
  spec: RepositoryWorkerSpec & { kind: "claude" | "codex" },
  options: {
    cwd: string;
    runsDir: string;
    owner: Readable;
    prompt: string;
    env: Readonly<Record<string, string>>;
    invocation?: { executable: string; args: readonly string[] };
  },
) {
  const argv = repositoryWorkerArgs(spec.kind, spec);
  const credentials = {
    ...(options.env.GH_TOKEN === undefined ? {} : { githubToken: options.env.GH_TOKEN }),
    ...(spec.kind !== "claude" || options.env.CLAUDE_CODE_OAUTH_TOKEN === undefined
      ? {}
      : { token: options.env.CLAUDE_CODE_OAUTH_TOKEN }),
  };
  const env =
    spec.kind === "claude"
      ? buildClaudeCodeEnvironment(options.env, `/work/.profiles/${spec.profile}`, credentials)
      : buildCodexEnvironment(options.env, `/profiles/${spec.profile}`, credentials);
  await mkdir(options.runsDir, { recursive: true });
  const scratch = join(options.runsDir, `omi-${spec.task}-tmp-${spec.packet}`);
  await mkdir(scratch, { recursive: true });
  env.TMPDIR = scratch;
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const stem = `omi-${spec.task}-${spec.kind === "codex" ? "codex-" : ""}${spec.profile}-${stamp}-${spec.packet}`;
  const log = join(options.runsDir, `${stem}.jsonl`);
  const err = join(options.runsDir, `${stem}.err`);
  const reference = join(options.runsDir, `omi-${spec.task}-process-${spec.packet}.json`);
  const secretValues = [options.env.GH_TOKEN, options.env.CLAUDE_CODE_OAUTH_TOKEN].filter(
    (value): value is string => value !== undefined,
  );
  await writeFile(log, "", { mode: 0o600 });
  const run = await runWorkerUnderOwner({
    owner: { channel: options.owner, heartbeatTimeoutMs: 15000, signals: ["SIGTERM", "SIGHUP"] },
    worker: {
      credentialPolicy: { sensitiveValues: secretValues },
      executable: options.invocation?.executable ?? spec.kind,
      args: options.invocation?.args ?? [
        ...argv.slice(1),
        ...(spec.kind === "codex"
          ? [...(spec.resume === null ? [] : ["resume", spec.resume]), "-"]
          : []),
      ],
      cwd: options.cwd,
      env,
      stdin: options.prompt,
      onStdoutLine: (line) => {
        appendFileSync(log, `${line}\n`);
        if (spec.kind === "codex") {
          try {
            const event: unknown = JSON.parse(line);
            const parsed = z
              .object({
                type: z.literal("item.completed"),
                item: z.object({ type: z.literal("agent_message"), text: z.string() }),
              })
              .safeParse(event);
            if (parsed.success)
              writeFileSync(join(options.runsDir, `${stem}-last.md`), parsed.data.item.text);
          } catch {
            /* non-message events stay in the structured log */
          }
        }
      },
      timeoutMs: 8 * 3_600_000,
      graceMs: 2000,
      maxStdoutChars: 100_000_000,
      maxLineChars: 1_000_000,
      maxStderrChars: 16000,
    },
  });
  try {
    const identity = startIdentity(run.worker.pid);
    if (identity === undefined) throw new Error("Docker worker identity unavailable");
    await writeFile(reference, JSON.stringify({ pid: run.worker.pid, startIdentity: identity }), {
      mode: 0o600,
    });
  } catch {
    run.worker.cancel("SIGINT", "group");
    await run.result;
    throw new Error("Docker worker identity could not be recorded");
  }
  const result = run.result.then(async (result) => {
    await writeFile(err, result.workerExit.stderr, { mode: 0o600 });
    await rm(scratch, { recursive: true, force: true });
    await rm(reference, { force: true });
    return result;
  });
  return { ...run, result };
}

const word = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const dockerWorkerSpecSchema = z.strictObject({
  task: z.string().regex(/^\d{1,6}$/),
  profile: word,
  kind: z.enum(["claude", "codex"]),
  model: word,
  effort: word,
  resume: word.nullable(),
  packet: word,
});

if (import.meta.main) {
  try {
    const [task, profile, kind, model, effort, resume, packet] = process.argv.slice(2);
    const spec = dockerWorkerSpecSchema.parse({
      task,
      profile,
      kind,
      model,
      effort,
      resume: resume === "-" ? null : resume,
      packet,
    });
    const runsDir = join(homedir(), "omi-runs");
    const prompt = await readFile(
      join(
        runsDir,
        `omi-${spec.task}-${spec.resume === null ? "prompt" : "resume"}-${spec.packet}.md`,
      ),
      "utf8",
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined),
    );
    const run = await runDockerWorker(spec, {
      cwd: process.cwd(),
      runsDir,
      owner: process.stdin,
      prompt,
      env,
    });
    const result = await run.result;
    const code = result.workerExit.exitCode ?? 1;
    process.stdout.write(`exit=${String(code)}\n`);
    process.exitCode = code;
  } catch {
    process.stderr.write("Docker worker failed\n");
    process.exitCode = 1;
  }
}
