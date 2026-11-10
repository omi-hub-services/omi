import { describe, expect, it } from "vitest";
import type { Command } from "../../../../src/application/contracts/command.js";
import { inspectRuntime } from "../../../../src/application/use-cases/project/inspect-runtime.js";
import { createCommandDispatcher } from "../../../../src/interfaces/ipc/command-dispatcher.js";

const identity = { runtimeVersion: "1.2.3", startedAt: "2026-11-10T12:00:00.000Z" };
const dispatch = createCommandDispatcher({ inspectRuntime: () => inspectRuntime(identity) });

describe("inspectRuntime use case", () => {
  it("reports ready with the identity bootstrap supplied", () => {
    expect(inspectRuntime(identity)).toEqual({ schemaVersion: 1, state: "ready", ...identity });
  });
});

describe("command dispatcher", () => {
  it("routes status to the use case", async () => {
    expect(await dispatch({ schemaVersion: 1, command: "status" })).toEqual({
      ok: true,
      result: inspectRuntime(identity),
    });
  });

  it("answers NOT_IMPLEMENTED, never success, for commands without a use case yet", async () => {
    const commands: Command[] = [
      { schemaVersion: 1, command: "plan", issueNumber: 1 },
      { schemaVersion: 1, command: "dispatch", runId: "run-1", stepId: "implement" },
      { schemaVersion: 1, command: "wait", runId: "run-1", timeoutSeconds: 5 },
      { schemaVersion: 1, command: "pause", runId: "run-1", reason: "test" },
      { schemaVersion: 1, command: "resume", runId: "run-1" },
      { schemaVersion: 1, command: "status", runId: "run-1" },
    ];
    for (const command of commands) {
      const outcome = await dispatch(command);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe("NOT_IMPLEMENTED");
    }
  });
});
