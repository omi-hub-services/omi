import { describe, expect, it } from "vitest";
import {
  dispatchPlannedRunStep,
  dispatchRunStep,
  type DispatchRunStepDependencies,
} from "../../../../../src/application/use-cases/runs/dispatch-run-step.ts";
import { dispatchStep } from "../../../../../src/application/use-cases/runs/dispatch-step.ts";
import { dispatchInput, rig } from "./run-fakes.ts";

describe("dispatchPlannedRunStep", () => {
  it.each(["attempt creation", "artifact write"])(
    "releases the writer and selector reservation when %s throws",
    async (failure) => {
      const seed = rig();
      const reservedAttemptId = "reserved-1";
      const seeded = await dispatchStep(seed.deps, dispatchInput({ reservedAttemptId }));
      if (!seeded.ok) throw new Error(seeded.reason);
      const r = rig();
      r.attempts.rows.set(reservedAttemptId, { ...seeded.attempt, status: "pending" });
      const error = new Error("storage failed");
      const fail = () => {
        throw error;
      };
      if (failure === "attempt creation") r.attempts.create = fail;
      else r.artifacts.write = fail;

      await expect(
        dispatchPlannedRunStep(
          {
            ...r.deps,
            runs: { get: fail, listSteps: fail },
            plans: { forRun: fail },
            workflows: { byId: fail, byHash: fail },
            session: { commit: fail },
            planner: { plan: fail },
            track: fail,
          },
          dispatchInput({ reservedAttemptId }),
          "step-1",
          "run-1",
        ),
      ).rejects.toBe(error);

      expect(r.workspaces.released).toEqual([1]);
      expect(r.attempts.get(reservedAttemptId)?.status).toBe("cancelled");
      expect(r.steps.get("step-1")?.status).toBe("ready");
      expect(r.executor.started).toHaveLength(0);
    },
  );
});

describe("dispatchRunStep resource wake-up", () => {
  function setup(status: "ready" | "waiting_resource" = "waiting_resource") {
    const r = rig(status);
    const completions: Promise<void>[] = [];
    const deps: DispatchRunStepDependencies = {
      ...r.deps,
      runs: {
        get: () => ({ id: "run-1", status: "running", version: 1 }),
        listSteps: () => [...r.steps.rows.values()],
      },
      plans: { forRun: () => undefined },
      workflows: { byId: () => undefined, byHash: () => undefined },
      session: {
        commit: (change) =>
          r.unitOfWork.commit({ ...change, at: new Date(r.deps.now()).toISOString() }),
      },
      planner: { plan: () => Promise.resolve(dispatchInput()) },
      track: (completion) => completions.push(completion),
    };
    return { r, deps, completions };
  }

  it("readies a waiting step only after selection and dispatches through completion routing", async () => {
    const { r, deps, completions } = setup();
    expect(await dispatchRunStep(deps, { runId: "run-1", stepId: "implement" })).toMatchObject({
      ok: true,
    });
    expect(r.executor.started).toHaveLength(1);
    expect(r.unitOfWork.commits[0]?.event.kind).toBe("step.resource_available");
    expect(completions).toHaveLength(1);
    await Promise.all(completions);
  });

  it("keeps a waiting step unchanged when selection has no candidate", async () => {
    const { r, deps } = setup();
    deps.planner.plan = () => Promise.resolve(undefined);
    expect(await dispatchRunStep(deps, { runId: "run-1", stepId: "implement" })).toMatchObject({
      ok: false,
      reason: "NOT_PLANNABLE",
    });
    expect(r.steps.get("step-1")?.status).toBe("waiting_resource");
    expect(r.unitOfWork.commits).toHaveLength(0);
  });

  it.each(["cancelled", "paused"] as const)(
    "releases a reservation when the run becomes %s during planning",
    async (status) => {
      const { r, deps } = setup("ready");
      const seeded = await dispatchStep(
        rig().deps,
        dispatchInput({ reservedAttemptId: "reserved-1" }),
      );
      if (!seeded.ok) throw new Error(seeded.reason);
      r.attempts.rows.set("reserved-1", { ...seeded.attempt, status: "pending" });
      let runStatus: "running" | "cancelled" | "paused" = "running";
      deps.runs.get = () => ({ id: "run-1", status: runStatus, version: 1 });
      deps.planner.plan = () => {
        runStatus = status;
        return Promise.resolve(dispatchInput({ reservedAttemptId: "reserved-1" }));
      };
      expect(await dispatchRunStep(deps, { runId: "run-1", stepId: "implement" })).toMatchObject({
        ok: false,
        reason: "RUN_NOT_RUNNING",
      });
      expect(r.attempts.get("reserved-1")?.status).toBe("cancelled");
      expect(r.executor.started).toHaveLength(0);
    },
  );

  it("releases the reservation if the resource-available commit throws", async () => {
    const { r, deps } = setup();
    const seeded = await dispatchStep(
      rig().deps,
      dispatchInput({ reservedAttemptId: "reserved-1" }),
    );
    if (!seeded.ok) throw new Error(seeded.reason);
    r.attempts.rows.set("reserved-1", { ...seeded.attempt, status: "pending" });
    deps.planner.plan = () => Promise.resolve(dispatchInput({ reservedAttemptId: "reserved-1" }));
    const error = new Error("commit failed");
    deps.session.commit = () => {
      throw error;
    };
    await expect(dispatchRunStep(deps, { runId: "run-1", stepId: "implement" })).rejects.toBe(
      error,
    );
    expect(r.attempts.get("reserved-1")?.status).toBe("cancelled");
    expect(r.executor.started).toHaveLength(0);
  });

  it("starts only one attempt when two dispatchers plan the same waiting revision", async () => {
    const { r, deps, completions } = setup();
    const results = await Promise.all([
      dispatchRunStep(deps, { runId: "run-1", stepId: "implement" }),
      dispatchRunStep(deps, { runId: "run-1", stepId: "implement" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(r.executor.started).toHaveLength(1);
    await Promise.all(completions);
  });
});
