import { describe, expect, it } from "vitest";
import type { RecoveryRun } from "../../../../../src/application/ports/run-recovery.ts";
import { handoffCoordinator } from "../../../../../src/application/use-cases/runs/handoff-coordinator.ts";
import type { PauseRunResult } from "../../../../../src/application/use-cases/runs/pause-run.ts";

function setup(runs: RecoveryRun[], pause: (runId: string) => PauseRunResult) {
  const recorded: { kind: string; payload: Readonly<Record<string, unknown>> }[] = [];
  const paused: string[] = [];
  return {
    recorded,
    paused,
    deps: {
      runs: { listActive: () => runs },
      pause: (runId: string) => {
        paused.push(runId);
        return Promise.resolve(pause(runId));
      },
      session: {
        record: (kind: string, payload: Readonly<Record<string, unknown>>) => {
          recorded.push({ kind, payload });
        },
      },
    },
  };
}
const run = (id: string, status: RecoveryRun["status"]): RecoveryRun => ({
  id,
  status,
  version: 1,
});

describe("handoffCoordinator", () => {
  it("pauses running runs, skips stopped ones and records the handoff once", async () => {
    const s = setup(
      [
        run("r1", "running"),
        run("r2", "paused"),
        run("r3", "waiting_resource"),
        run("r4", "blocked"),
      ],
      (id) => ({ ok: true, checkpointId: `cp-${id}` }),
    );
    expect(await handoffCoordinator(s.deps, { reason: "new-session" })).toEqual({
      ok: true,
      paused: [
        { runId: "r1", checkpointId: "cp-r1" },
        { runId: "r3", checkpointId: "cp-r3" },
      ],
      alreadyStopped: ["r2", "r4"],
    });
    expect(s.recorded).toEqual([
      {
        kind: "coordinator.handoff",
        payload: {
          reason: "new-session",
          paused: [
            { runId: "r1", checkpointId: "cp-r1" },
            { runId: "r3", checkpointId: "cp-r3" },
          ],
          alreadyStopped: ["r2", "r4"],
        },
      },
    ]);
  });

  it("stops at the first run that cannot be paused and records no handoff", async () => {
    const s = setup([run("r1", "running"), run("r2", "running")], (id) =>
      id === "r1" ? { ok: false, reason: "WORKER_NOT_OWNED" } : { ok: true, checkpointId: "cp" },
    );
    expect(await handoffCoordinator(s.deps, { reason: "new-session" })).toEqual({
      ok: false,
      reason: "PAUSE_FAILED",
      detail: "r1: WORKER_NOT_OWNED",
    });
    expect(s.paused).toEqual(["r1"]);
    expect(s.recorded).toEqual([]);
  });

  it("records the label of the next Coordinator profile for a switch, and requires it", async () => {
    const s = setup([], () => ({ ok: true, checkpointId: "cp" }));
    expect(await handoffCoordinator(s.deps, { reason: "profile-switch" })).toEqual({
      ok: false,
      reason: "PROFILE_REQUIRED",
    });
    expect(
      await handoffCoordinator(s.deps, { reason: "profile-switch", toProfile: "coordinator-b" }),
    ).toMatchObject({ ok: true });
    expect(s.recorded).toMatchObject([
      { payload: { reason: "profile-switch", toProfile: "coordinator-b" } },
    ]);
  });

  it.each([
    [{ reason: "other" }],
    [{ reason: "new-session", toProfile: "Not A Slug" }],
    [{ reason: "new-session", extra: 1 }],
  ])("refuses invalid input %j", async (input) => {
    const s = setup([run("r1", "running")], () => ({ ok: true, checkpointId: "cp" }));
    expect(await handoffCoordinator(s.deps, input)).toEqual({ ok: false, reason: "INVALID_INPUT" });
    expect(s.paused).toEqual([]);
  });
});
