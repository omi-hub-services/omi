import { describe, expect, it } from "vitest";
import {
  advanceRun,
  type AdvanceRunDependencies,
} from "../../../../../src/application/use-cases/runs/advance-run.ts";

describe("advanceRun", () => {
  it.each(["a".repeat(64), "b".repeat(64)])(
    "includes the pinned hash %s when the catalog template is unavailable",
    (templateHash) => {
      const commits: Parameters<AdvanceRunDependencies["session"]["commit"]>[0][] = [];
      const deps: AdvanceRunDependencies = {
        runs: {
          get: () => ({ id: "run-1", status: "running", version: 1 }),
          listSteps: () => [
            { id: "step-1", runId: "run-1", stepId: "implement", status: "pending", version: 1 },
          ],
        },
        plans: {
          forRun: () => ({
            taskId: "task-1",
            projectId: "p",
            repository: "acme/app",
            issueNumber: 1,
            templateHash,
          }),
        },
        workflows: { byId: () => undefined, byHash: () => undefined },
        session: {
          commit: (change) => {
            commits.push(change);
            return { ok: true, newVersion: 2, eventSequence: 1 };
          },
        },
        nextId: () => "event-1",
      };

      expect(advanceRun(deps, { runId: "run-1" })).toEqual({
        ok: false,
        reason: "WORKFLOW_UNKNOWN",
        detail: `template_hash=${templateHash}`,
      });
      expect(commits).toEqual([]);

      expect(
        advanceRun({ ...deps, plans: { forRun: () => undefined } }, { runId: "run-1" }),
      ).toEqual({ ok: false, reason: "WORKFLOW_UNKNOWN" });
      expect(commits).toEqual([]);
    },
  );
});
