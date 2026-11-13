import { describe, expect, it } from "vitest";
import type { Command } from "../../../../src/application/contracts/command.js";
import { inspectRuntime } from "../../../../src/application/use-cases/project/inspect-runtime.js";
import { createCommandDispatcher } from "../../../../src/interfaces/ipc/command-dispatcher.js";

const identity = { runtimeVersion: "1.2.3", startedAt: "2026-11-10T12:00:00.000Z" };
const command: Command = {
  schemaVersion: 1,
  command: "release.merge",
  release: "r1",
  prNumber: 5,
  expectedHeadSha: "a".repeat(40),
  requiredChecks: ["ci"],
};

describe("release merge command dispatch", () => {
  it("routes to the runtime-owned use case without the routing fields", async () => {
    const outcome = await createCommandDispatcher({
      inspectRuntime: () => inspectRuntime(identity),
      mergeRelease: (input: unknown) => ({ ok: true as const, received: input }),
    })(command);
    expect(outcome).toMatchObject({
      ok: true,
      result: { received: { release: "r1", prNumber: 5 } },
    });
  });

  it("keeps the refusal reason and detail", async () => {
    const outcome = await createCommandDispatcher({
      inspectRuntime: () => inspectRuntime(identity),
      mergeRelease: () => ({
        ok: false as const,
        reason: "RELEASE_MERGE_REFUSED",
        detail: "gate: PO_APPROVAL_MISSING",
      }),
    })(command);
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "COMMAND_REFUSED",
        message: "RELEASE_MERGE_REFUSED: gate: PO_APPROVAL_MISSING",
      },
    });
  });

  it("answers NOT_IMPLEMENTED, never success, without a use case", async () => {
    const outcome = await createCommandDispatcher({
      inspectRuntime: () => inspectRuntime(identity),
    })(command);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("NOT_IMPLEMENTED");
  });
});
