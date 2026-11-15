import { describe, expect, it } from "vitest";
import { pauseRun } from "../../../../../src/application/use-cases/runs/pause-run.ts";
import { dispatchStep } from "../../../../../src/application/use-cases/runs/dispatch-step.ts";
import { recoveryRig } from "./recovery-fakes.ts";
import { dispatchInput, h, sha } from "./run-fakes.ts";

async function setup() {
  const r = recoveryRig();
  r.state.run = { ...r.state.run, status: "running" };
  const step = r.r.steps.must("step-1");
  r.r.steps.rows.set(step.id, { ...step, status: "ready" });
  const dispatched = await dispatchStep(r.r.deps, dispatchInput());
  if (!dispatched.ok) throw new Error(dispatched.reason);
  r.state.worker = "owned-running";
  const deps = {
    ...r.deps,
    hasher: { sha256: sha },
    snapshot: () => ({
      workspacePath: "/work/omi-027",
      stepRunId: "step-1",
      stepId: "implement",
      hashes: { config: h("1"), template: h("2") },
      taskSnapshot: { issueNumber: 32, title: "Recovery", body: "Resume." },
      acceptanceCriteria: ["works"],
      businessBaselineHash: h("9"),
      counters: { retryCount: 1 },
      nextAction: { action: "dispatch-step", stepId: "implement" },
    }),
  };
  return { ...r, deps, dispatched };
}

describe("pauseRun", () => {
  it("stops the owned writer before taking a stable pause checkpoint", async () => {
    const r = await setup();
    const result = await pauseRun(r.deps, { runId: "run-1" });
    expect(result).toMatchObject({ ok: true });
    expect(r.state.order).toEqual(["process", "stop", "process"]);
    expect(r.records.size).toBe(1);
    expect([...r.records.values()][0]?.kind).toBe("pause");
    expect(r.state.run.status).toBe("paused");
    expect(r.r.steps.must("step-1").status).toBe("paused");
    expect(r.r.attempts.get(r.dispatched.attempt.id)?.status).toBe("interrupted");
  });

  it("preserves a live unowned process and refuses to snapshot or release it", async () => {
    const r = await setup();
    r.state.worker = "unowned-running";
    expect(await pauseRun(r.deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "WORKER_NOT_OWNED",
    });
    expect(r.records.size).toBe(0);
    expect(r.r.workspaces.released).toEqual([]);
    expect(r.state.run.status).toBe("running");
  });

  it("does not record a pause when checkpoint persistence fails", async () => {
    const r = await setup();
    expect(
      await pauseRun(
        { ...r.deps, snapshot: () => ({ ...r.deps.snapshot(), workspacePath: "relative" }) },
        { runId: "run-1" },
      ),
    ).toMatchObject({ ok: false, reason: "CHECKPOINT_FAILED" });
    expect(r.state.run.status).toBe("running");
  });
});
