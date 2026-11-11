import { describe, expect, it } from "vitest";
import type { StepStatus } from "../../../../../src/domain/runs/step-run.ts";
import type { RunStatus } from "../../../../../src/domain/runs/workflow-run.ts";
import { waitForRun } from "../../../../../src/application/use-cases/runs/wait-for-run.ts";

function setup(initial: { run: RunStatus; steps: StepStatus[] }) {
  const state = { ...initial };
  const clock = { ms: 0 };
  const sleeps: number[] = [];
  return {
    state,
    sleeps,
    deps: {
      runs: {
        get: (id: string) => (id === "run-1" ? { id, status: state.run, version: 1 } : undefined),
        listSteps: () =>
          state.steps.map((status, index) => ({
            id: `s${String(index)}`,
            runId: "run-1",
            stepId: `step-${String(index)}`,
            status,
            version: 1,
          })),
      },
      now: () => clock.ms,
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock.ms += ms;
        return Promise.resolve();
      },
      pollMs: 1000,
    },
  };
}

describe("waitForRun", () => {
  it("returns at once when no worker is running", async () => {
    const s = setup({ run: "running", steps: ["succeeded", "ready"] });
    expect(await waitForRun(s.deps, { runId: "run-1", timeoutSeconds: 60 })).toMatchObject({
      ok: true,
      timedOut: false,
    });
    expect(s.sleeps).toEqual([]);
  });

  it("returns when the worker finishes while waiting", async () => {
    const s = setup({ run: "running", steps: ["running"] });
    const done = waitForRun(
      {
        ...s.deps,
        sleep: (ms) => {
          s.state.steps = ["succeeded"];
          return s.deps.sleep(ms);
        },
      },
      { runId: "run-1", timeoutSeconds: 60 },
    );
    expect(await done).toMatchObject({
      ok: true,
      timedOut: false,
      run: { steps: [{ status: "succeeded" }] },
    });
  });

  it("gives up at the timeout while a worker still runs", async () => {
    const s = setup({ run: "running", steps: ["running"] });
    expect(await waitForRun(s.deps, { runId: "run-1", timeoutSeconds: 3 })).toMatchObject({
      ok: true,
      timedOut: true,
    });
    expect(s.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(3000);
  });

  it("does not wait on a run that left running", async () => {
    const s = setup({ run: "paused", steps: ["running"] });
    expect(await waitForRun(s.deps, { runId: "run-1", timeoutSeconds: 60 })).toMatchObject({
      ok: true,
      timedOut: false,
    });
  });

  it.each([
    [{ runId: "run-1", timeoutSeconds: 0 }, "INVALID_INPUT"],
    [{ runId: "run-1", timeoutSeconds: 3601 }, "INVALID_INPUT"],
    [{ runId: "run 1", timeoutSeconds: 5 }, "INVALID_INPUT"],
    [{ runId: "other", timeoutSeconds: 5 }, "RUN_NOT_FOUND"],
  ])("refuses %j with %s", async (input, reason) => {
    const s = setup({ run: "running", steps: [] });
    expect(await waitForRun(s.deps, input)).toEqual({ ok: false, reason });
  });
});
