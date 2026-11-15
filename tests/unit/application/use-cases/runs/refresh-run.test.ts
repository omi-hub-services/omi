import { describe, expect, it } from "vitest";
import { workflowSchema } from "../../../../../src/application/contracts/workflow.ts";
import {
  GitWorkspaceError,
  type GitWorkspace,
  type GitWorkspaceErrorCode,
} from "../../../../../src/application/ports/git-workspace.ts";
import type { ReopenSteps } from "../../../../../src/application/ports/run-plan-store.ts";
import { refreshRun } from "../../../../../src/application/use-cases/runs/refresh-run.ts";

const OLD_BASE = "b".repeat(40);
const NEW_BASE = "d".repeat(40);
const OLD_HEAD = "a".repeat(40);
const NEW_HEAD = "e".repeat(40);

const workflow = workflowSchema.parse({
  schema_version: 1,
  id: "bugfix",
  version: 1,
  selection: { task_types: ["bugfix"] },
  quality_policy: "strict",
  steps: [
    {
      id: "implement",
      role: "developer",
      needs: [],
      capability_profile: "coding",
      output_contract: "step-result",
    },
    {
      id: "verify",
      role: "qa",
      needs: ["implement"],
      capability_profile: "testing",
      output_contract: "step-result",
    },
    {
      id: "review",
      role: "reviewer",
      needs: ["verify"],
      capability_profile: "review",
      output_contract: "step-result",
    },
  ],
  gates: [],
});

function rig(
  options: {
    statuses?: Record<string, string>;
    runStatus?: string;
    reviewBase?: string | undefined;
    developHead?: string;
    merge?: GitWorkspaceErrorCode;
    reopenFails?: boolean;
    branch?: string;
  } = {},
) {
  const calls: string[] = [];
  const reopened: ReopenSteps[] = [];
  const statuses = options.statuses ?? {};
  const stepRuns = ["implement", "verify", "review"].map((stepId) => ({
    id: `sr-${stepId}`,
    runId: "run-1",
    stepId,
    status: (statuses[stepId] ?? "succeeded") as "succeeded",
    version: 3,
  }));
  const workspace = {
    taskId: "omi-141",
    slug: "refresh-run",
    path: "/work/omi-141",
    branch: "task/omi-141-refresh-run",
    owner: "old",
    leaseKey: "k",
    generation: 1,
  };
  const workspaces: GitWorkspace = {
    developHead: () => ({ ok: true, value: options.developHead ?? NEW_BASE }),
    mergeDevelop: () => {
      calls.push("merge");
      return options.merge === undefined
        ? { ok: true, value: { headSha: NEW_HEAD } }
        : { ok: false, error: new GitWorkspaceError(options.merge) };
    },
    inspect: () => ({
      ok: true,
      value: {
        path: workspace.path,
        headSha: OLD_HEAD,
        branch: options.branch ?? workspace.branch,
        dirty: false,
        hasIgnoredFiles: false,
      },
    }),
    acquireWriter: (request: { owner: string; now: string; expiresAt: string }) => {
      calls.push("acquire");
      return {
        ok: true,
        value: {
          resourceKey: "w",
          owner: request.owner,
          generation: 4,
          acquiredAt: request.now,
          expiresAt: request.expiresAt,
        },
      };
    },
    releaseWriter: () => {
      calls.push("release");
      return { ok: true, value: undefined };
    },
  } as unknown as GitWorkspace;
  const deps = {
    runs: {
      get: () => ({
        id: "run-1",
        status: (options.runStatus ?? "running") as "running",
        version: 1,
      }),
      listSteps: () => stepRuns,
    },
    plans: {
      forRun: () => ({
        taskId: "t",
        projectId: "p",
        repository: "acme/app",
        issueNumber: 1,
        templateHash: "h",
      }),
      reopenSteps: (request: ReopenSteps) => {
        calls.push("reopen");
        reopened.push(request);
        return options.reopenFails
          ? { ok: false as const, reason: "STEPS_NOT_FINISHED" as const }
          : { ok: true as const };
      },
    },
    workflows: { byId: () => undefined, byHash: () => ({ workflow, hash: "h" }) },
    attempts: {
      latestForStep: () => ({ workspace }),
      qualityHistory: () => ({
        round: 1,
        previousVerdict:
          "reviewBase" in options && options.reviewBase === undefined
            ? undefined
            : { revision: { headSha: OLD_HEAD, baseSha: options.reviewBase ?? OLD_BASE } },
      }),
    },
    workspaces,
    now: () => Date.parse("2026-11-14T00:00:00.000Z"),
    nextId: (() => {
      let n = 0;
      return () => `id-${String((n += 1))}`;
    })(),
  };
  return { deps: deps as unknown as Parameters<typeof refreshRun>[0], calls, reopened };
}

describe("refreshRun", () => {
  it("merges develop under the writer lease and reopens verify and review as the next iteration", () => {
    const { deps, calls, reopened } = rig();
    const result = refreshRun(deps, { runId: "run-1" });
    expect(result).toEqual({
      ok: true,
      headSha: NEW_HEAD,
      reopened: ["verify", "review"],
    });
    expect(calls).toEqual(["acquire", "merge", "release", "reopen"]);
    expect(reopened).toHaveLength(1);
    // verify has only implement (not reopened) to wait for; review waits for the new verify.
    expect(reopened[0]?.steps.map((s) => [s.stepId, s.status])).toEqual([
      ["verify", "ready"],
      ["review", "pending"],
    ]);
    expect(reopened[0]?.headSha).toBe(NEW_HEAD);
  });

  it("refuses an unfinished run without touching git", () => {
    const { deps, calls } = rig({ statuses: { review: "running" } });
    expect(refreshRun(deps, { runId: "run-1" })).toEqual({
      ok: false,
      reason: "RUN_NOT_FINISHED",
    });
    expect(calls).toEqual([]);
  });

  it("refuses when the review already matches the current develop head", () => {
    const { deps, calls } = rig({ developHead: OLD_BASE });
    expect(refreshRun(deps, { runId: "run-1" })).toEqual({ ok: false, reason: "REVIEW_CURRENT" });
    expect(calls).toEqual([]);
  });

  it("refuses when there is no review verdict revision to compare", () => {
    const { deps, calls } = rig({ reviewBase: undefined });
    expect(refreshRun(deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "REVIEW_REVISION_MISSING",
    });
    expect(calls).toEqual([]);
  });

  it("names a conflict, keeps the steps and still releases the writer lease", () => {
    const { deps, calls } = rig({ merge: "MERGE_CONFLICT" });
    expect(refreshRun(deps, { runId: "run-1" })).toEqual({
      ok: false,
      reason: "REFRESH_CONFLICT",
    });
    expect(calls).toEqual(["acquire", "merge", "release"]);
  });

  it("refuses a workspace on another branch", () => {
    const { deps, calls } = rig({ branch: "other" });
    expect(refreshRun(deps, { runId: "run-1" })).toEqual({
      ok: false,
      reason: "WORKSPACE_MISMATCH",
    });
    expect(calls).toEqual([]);
  });

  it("reports a refused state change after the merge", () => {
    const { deps } = rig({ reopenFails: true });
    expect(refreshRun(deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "STATE_REJECTED",
    });
  });

  it("refuses an invalid input and a run that is not running", () => {
    expect(refreshRun(rig().deps, { runId: "run-1", extra: 1 })).toEqual({
      ok: false,
      reason: "INVALID_INPUT",
    });
    expect(refreshRun(rig({ runStatus: "succeeded" }).deps, { runId: "run-1" })).toEqual({
      ok: false,
      reason: "RUN_NOT_RUNNING",
    });
  });
});
