import { expect, it } from "vitest";
import { deliverRun } from "../../../src/application/use-cases/delivery/deliver-run.ts";
import { sandbox, request } from "../../e2e/merge-task-pr-sandbox.ts";

it.each([false, true])(
  "returns a named refusal for an absent or mismatched mapping (mapped=%s)",
  async (mapped) => {
    const h = sandbox({ mapped });
    const result = deliverRun(
      {
        runs: { get: () => ({ id: "r", status: "running", version: 1 }), listSteps: () => [] },
        plans: { forRun: () => ({ ...request, templateHash: "a".repeat(64) }) },
        merge: h.deps,
        session: {
          commit: () => {
            throw new Error("MUST_NOT_COMPLETE");
          },
        },
        nextId: () => "id",
      },
      {
        runId: "r",
        prNumber: 999,
        reviewedHeadSha: request.reviewedHeadSha,
        requiredChecks: ["ci"],
      },
    );
    await expect(result).resolves.toEqual({ ok: false, reason: "MAPPING_MISMATCH" });
  },
);
