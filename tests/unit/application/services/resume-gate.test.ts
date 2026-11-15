import { describe, expect, it, vi } from "vitest";
import { createResumeGate } from "../../../../src/application/services/resume-gate.ts";
import { DispatchPlanningError } from "../../../../src/application/services/dispatch-planning-error.ts";
import type { CheckpointManifest } from "../../../../src/application/contracts/checkpoint.ts";

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);

type Task = { context: { businessBaselineHash: string; approvalRefs: string[] } };

function gate(
  read: () => Promise<Task>,
  overrides: { templateHash?: string; configHash?: string } = {},
) {
  const taskRead = vi.fn(read);
  const resume = createResumeGate({
    plans: {
      forRun: () => ({ taskId: "task-3", templateHash: overrides.templateHash ?? "tpl" }),
    },
    configHash: overrides.configHash ?? "cfg",
    taskReader: { read: taskRead },
  });
  const checkpoint = {
    runId: "run-1",
    hashes: { template: "tpl", config: "cfg" },
    businessBaselineHash: OLD,
  } as unknown as CheckpointManifest;
  return { resume, checkpoint, taskRead };
}
const current = (hash: string, approvalId = "approval-new"): Promise<Task> =>
  Promise.resolve({ context: { businessBaselineHash: hash, approvalRefs: [approvalId] } });

describe("createResumeGate", () => {
  it("passes without a rebaseline when the baseline is unchanged", async () => {
    const { resume, checkpoint } = gate(() => current(OLD));
    expect(await resume(checkpoint, [])).toEqual({ ok: true });
  });

  it("accepts a changed baseline that has a current approval and reports the rebaseline", async () => {
    const { resume, checkpoint } = gate(() => current(NEW));
    expect(await resume(checkpoint, [])).toEqual({
      ok: true,
      rebaseline: { from: OLD, to: NEW, approvalIds: ["approval-new"] },
    });
  });

  it.each(["BUSINESS_APPROVAL_STALE", "BUSINESS_APPROVAL_REQUIRED"] as const)(
    "refuses a changed baseline without a current approval: %s",
    async (reason) => {
      const { resume, checkpoint } = gate(() => Promise.reject(new DispatchPlanningError(reason)));
      expect(await resume(checkpoint, [])).toEqual({ ok: false, reason });
    },
  );

  it("still refuses a changed config or template before reading the task", async () => {
    const { resume, checkpoint, taskRead } = gate(() => current(NEW), { configHash: "other" });
    expect(await resume(checkpoint, [])).toEqual({
      ok: false,
      reason: "CONFIG_OR_TEMPLATE_CHANGED",
    });
    expect(taskRead).not.toHaveBeenCalled();
  });

  it("does not swallow unexpected reader failures", async () => {
    const { resume, checkpoint } = gate(() => Promise.reject(new Error("boom")));
    await expect(resume(checkpoint, [])).rejects.toThrow("boom");
  });
});
