import { describe, expect, it } from "vitest";
import { runCli } from "../../../../src/interfaces/cli/commands/create-program.ts";
import type { IpcOutcome } from "../../../../src/interfaces/ipc/protocol.ts";

type Outcome = IpcOutcome;

const PLAN_OK: Outcome = {
  ok: true,
  result: {
    runId: "run-1",
    taskId: "t",
    workflowId: "feature",
    steps: [
      { stepRunId: "s0", stepId: "analyze", status: "pending" },
      { stepRunId: "s1", stepId: "implement", status: "ready" },
      { stepRunId: "s2", stepId: "review", status: "ready" },
    ],
  },
};
const DISPATCH_OK: Outcome = {
  ok: true,
  result: { runId: "run-1", stepRunId: "s1", attemptId: "att-1" },
};

async function run(argv: string[], replies: Record<string, Outcome>) {
  const sent: Record<string, unknown>[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    sendCommand: (input) => {
      const command = input.command as unknown as Record<string, unknown>;
      sent.push(command);
      return Promise.resolve(
        replies[command["command"] as string] ?? {
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "unexpected command" },
        },
      );
    },
    defaultSocketPath: "/unused",
    timeoutMs: 100,
    version: "0",
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, sent, out: out.join(""), err: err.join("") };
}

describe("omi run", () => {
  it("plans, dispatches the first ready step and prints the ids", async () => {
    const r = await run(["run", "--issue", "7", "--workflow", "feature"], {
      plan: PLAN_OK,
      dispatch: DISPATCH_OK,
    });
    expect(r.code).toBe(0);
    expect(r.sent).toEqual([
      { schemaVersion: 1, command: "plan", issueNumber: 7, workflowId: "feature" },
      { schemaVersion: 1, command: "dispatch", runId: "run-1", stepId: "implement" },
    ]);
    expect(r.out).toContain("run-1");
    expect(r.out).toContain("implement");
    expect(r.out).toContain("att-1");
  });

  it("prints runId, stepId and attemptId under --json", async () => {
    const r = await run(["run", "--issue", "7", "--json"], {
      plan: PLAN_OK,
      dispatch: DISPATCH_OK,
    });
    expect(JSON.parse(r.out)).toEqual({
      schemaVersion: 1,
      ok: true,
      exitCode: 0,
      result: { runId: "run-1", stepId: "implement", attemptId: "att-1" },
    });
  });

  it("dispatches the named --step and lets the runtime judge readiness", async () => {
    const r = await run(["run", "--issue", "7", "--step", "analyze"], {
      plan: PLAN_OK,
      dispatch: {
        ok: false,
        error: { code: "COMMAND_REFUSED", message: "STEP_NOT_READY" },
      },
    });
    expect(r.sent[1]).toMatchObject({ command: "dispatch", stepId: "analyze" });
    expect(r.code).toBe(4);
    expect(r.err).toContain("STEP_NOT_READY");
  });

  it.each([
    "APPROVAL_MISSING: execution approval is required",
    "PROFILE_NOT_READY: no ready profile",
    "WRITER_LEASE_HELD: another writer",
    "RUN_NOT_RUNNING",
  ])("returns the dispatch refusal %j unchanged and sends nothing more", async (message) => {
    const r = await run(["run", "--issue", "7", "--json"], {
      plan: PLAN_OK,
      dispatch: { ok: false, error: { code: "COMMAND_REFUSED", message } },
    });
    expect(r.code).toBe(4);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      error: { code: "COMMAND_REFUSED", message },
    });
    expect(r.sent.map((c) => c["command"])).toEqual(["plan", "dispatch"]);
  });

  it("does not dispatch when the plan is refused and returns that refusal", async () => {
    const r = await run(["run", "--issue", "7", "--json"], {
      plan: { ok: false, error: { code: "COMMAND_REFUSED", message: "ACTIVE_RUN_EXISTS" } },
    });
    expect(r.code).toBe(4);
    expect(JSON.parse(r.out)).toMatchObject({ error: { message: "ACTIVE_RUN_EXISTS" } });
    expect(r.sent.map((c) => c["command"])).toEqual(["plan"]);
  });

  it("refuses with STEP_NOT_READY and does not dispatch when no step is ready", async () => {
    const r = await run(["run", "--issue", "7", "--json"], {
      plan: {
        ok: true,
        result: { runId: "run-1", steps: [{ stepId: "a", status: "pending" }] },
      },
    });
    expect(r.code).toBe(4);
    expect(JSON.parse(r.out)).toMatchObject({
      error: { code: "COMMAND_REFUSED", message: "STEP_NOT_READY" },
    });
    expect(r.sent.map((c) => c["command"])).toEqual(["plan"]);
  });

  it("is a usage error without --issue and sends nothing", async () => {
    const r = await run(["run"], {});
    expect(r.code).toBe(2);
    expect(r.sent).toEqual([]);
  });
});
