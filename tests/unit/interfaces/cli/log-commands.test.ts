import { describe, expect, it } from "vitest";
import type { RetainWorkerLogsResult } from "../../../../src/application/use-cases/runs/retain-worker-logs.ts";
import { runCli } from "../../../../src/interfaces/cli/commands/create-program.ts";
import type { LogCommands } from "../../../../src/interfaces/cli/commands/log-commands.ts";

const RESULT: RetainWorkerLogsResult = {
  dryRun: true,
  decisions: [{ name: "task-1--a--1.jsonl", action: "archive", reason: "log of a Done task" }],
  archived: 1,
  removed: 0,
  kept: 2,
  failed: [],
};

function setup(result: RetainWorkerLogsResult = RESULT) {
  const calls: unknown[] = [];
  const logs: LogCommands = {
    pruneLogs: (input) => {
      calls.push(input);
      return Promise.resolve(result);
    },
  };
  let out = "";
  let err = "";
  const run = async (...argv: string[]) => {
    out = "";
    err = "";
    const code = await runCli(argv, {
      sendCommand: () => Promise.reject(new Error("no runtime needed")),
      defaultSocketPath: "/nowhere.sock",
      timeoutMs: 100,
      version: "0.0.0",
      stdout: (text) => (out += text),
      stderr: (text) => (err += text),
      logs,
    });
    return { code, out, err };
  };
  return { run, calls };
}

describe("prune-logs", () => {
  it("passes the Done tasks and --dry-run to the use case and lists the plan", async () => {
    const { run, calls } = setup();
    const { code, out } = await run(
      "prune-logs",
      "--project",
      "/p",
      "--task",
      "task-1",
      "--task",
      "task-2",
      "--dry-run",
    );
    expect(code).toBe(0);
    expect(calls).toEqual([{ projectDir: "/p", doneTasks: ["task-1", "task-2"], dryRun: true }]);
    expect(out).toContain("dry run");
    expect(out).toContain("archive task-1--a--1.jsonl");
  });

  it("applies by default and still caps the archive when no task is given", async () => {
    const { run, calls } = setup({ ...RESULT, dryRun: false });
    expect((await run("prune-logs", "--project", "/p")).code).toBe(0);
    expect(calls).toEqual([{ projectDir: "/p", doneTasks: [], dryRun: false }]);
  });

  it("prints one JSON document with --json", async () => {
    const { run } = setup();
    const { out } = await run("--json", "prune-logs", "--project", "/p");
    expect(JSON.parse(out)).toMatchObject({
      ok: true,
      result: { archived: 1, kept: 2, dryRun: true },
    });
  });

  it("exits non-zero and names the files that failed", async () => {
    const { run } = setup({ ...RESULT, dryRun: false, failed: ["task-1--a--1.jsonl"] });
    const { code, err, out } = await run("prune-logs", "--project", "/p");
    expect(code).not.toBe(0);
    expect(err + out).toContain("task-1--a--1.jsonl");
  });

  it("reports a usage error for a task id that cannot name a log", async () => {
    const { run, calls } = setup();
    const { code } = await run("prune-logs", "--project", "/p", "--task", "../x");
    expect(code).not.toBe(0);
    expect(calls).toEqual([]);
  });
});
