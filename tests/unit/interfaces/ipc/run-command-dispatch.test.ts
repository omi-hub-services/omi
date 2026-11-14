import { describe, expect, it } from "vitest";
import { commandSchema, type Command } from "../../../../src/application/contracts/command.ts";
import { inspectRuntime } from "../../../../src/application/use-cases/project/inspect-runtime.ts";
import { createCommandDispatcher } from "../../../../src/interfaces/ipc/command-dispatcher.ts";
import type { DispatchedUseCases } from "../../../../src/interfaces/ipc/command-dispatcher.ts";

const identity = { runtimeVersion: "1.2.3", startedAt: "2026-11-11T00:00:00.000Z" };
const base: DispatchedUseCases = { inspectRuntime: () => inspectRuntime(identity) };
const SHA = "a".repeat(40);

it("accepts prepare-pr without caller-supplied task identities", () => {
  const input = {
    schemaVersion: 1,
    command: "prepare-pr",
    runId: "r",
    title: "Task",
    evidence: ["test"],
  };
  expect(commandSchema.safeParse(input).success).toBe(true);
  for (const key of ["projectId", "repository", "issueNumber", "taskId", "head"]) {
    expect(commandSchema.safeParse({ ...input, [key]: "forged" }).success).toBe(false);
  }
});

const commands: [string, Command, keyof DispatchedUseCases][] = [
  ["retry", { schemaVersion: 1, command: "retry", runId: "r", stepId: "s" }, "retryStep"],
  [
    "rework.record",
    {
      schemaVersion: 1,
      command: "rework.record",
      runId: "r",
      event: { type: "po_reopened", poDecisionId: "d" },
    },
    "recordReworkEvent",
  ],
  ["sync", { schemaVersion: 1, command: "sync", issueNumbers: [235] }, "sync"],
  ["plan", { schemaVersion: 1, command: "plan", issueNumber: 3, workflowId: "demo" }, "planRun"],
  [
    "dispatch",
    { schemaVersion: 1, command: "dispatch", runId: "r", stepId: "s" },
    "dispatchRunStep",
  ],
  ["wait", { schemaVersion: 1, command: "wait", runId: "r", timeoutSeconds: 5 }, "waitForRun"],
  ["status run", { schemaVersion: 1, command: "status", runId: "r" }, "inspectRun"],
  ["pause", { schemaVersion: 1, command: "pause", runId: "r", reason: "why" }, "pauseRun"],
  ["resume", { schemaVersion: 1, command: "resume", runId: "r" }, "resumeRun"],
  [
    "prepare-pr",
    { schemaVersion: 1, command: "prepare-pr", runId: "r", title: "Task", evidence: ["test"] },
    "prepareRunPr",
  ],
  [
    "deliver",
    {
      schemaVersion: 1,
      command: "deliver",
      runId: "r",
      prNumber: 9,
      reviewedHeadSha: SHA,
      requiredChecks: ["ci"],
      minimumNativeApprovals: 0,
    },
    "deliverRun",
  ],
  [
    "handoff",
    { schemaVersion: 1, command: "handoff", reason: "new-session" },
    "handoffCoordinator",
  ],
];

describe("run commands in the dispatcher", () => {
  it.each(commands)(
    "%s answers NOT_IMPLEMENTED until its use case is bound",
    async (_n, command) => {
      expect(await createCommandDispatcher(base)(command)).toMatchObject({
        ok: false,
        error: { code: "NOT_IMPLEMENTED" },
      });
    },
  );

  it.each(commands)(
    "%s passes the payload, without routing fields, to %s",
    async (_n, command, key) => {
      const seen: unknown[] = [];
      const handler = createCommandDispatcher({
        ...base,
        [key]: (input: unknown) => {
          seen.push(input);
          return { ok: true, marker: key };
        },
      });
      expect(await handler(command)).toEqual({ ok: true, result: { marker: key } });
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toHaveProperty("command");
      expect(seen[0]).not.toHaveProperty("schemaVersion");
    },
  );

  it("maps a use case refusal to COMMAND_REFUSED with reason and detail", async () => {
    const handler = createCommandDispatcher({
      ...base,
      dispatchRunStep: () => ({ ok: false, reason: "STEP_NOT_READY", detail: "implement" }),
    });
    expect(
      await handler({ schemaVersion: 1, command: "dispatch", runId: "r", stepId: "implement" }),
    ).toEqual({
      ok: false,
      error: { code: "COMMAND_REFUSED", message: "STEP_NOT_READY: implement" },
    });
  });

  it("keeps the runtime status for a status command without a run id", async () => {
    expect(await createCommandDispatcher(base)({ schemaVersion: 1, command: "status" })).toEqual({
      ok: true,
      result: inspectRuntime(identity),
    });
  });
});
