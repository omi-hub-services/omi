import { describe, expect, it } from "vitest";
import type { CheckRunRecord } from "../../../../../src/application/contracts/check-run.ts";
import type { MergeEvidence } from "../../../../../src/application/contracts/merge-delivery.ts";
import type {
  BranchSync,
  MergeBaseResult,
} from "../../../../../src/application/ports/branch-sync.ts";
import type { CheckRunner } from "../../../../../src/application/ports/check-runner.ts";
import type { GitWorkspace } from "../../../../../src/application/ports/git-workspace.ts";
import { carryPassOverSync } from "../../../../../src/application/use-cases/delivery/carry-pass-over-sync.ts";
import type { CarryFacts } from "../../../../../src/domain/delivery/carried-pass-policy.ts";

const OLD = "a".repeat(40);
const BASE = "b".repeat(40);
const NEW = "c".repeat(40);
const TREE = "d".repeat(40);
const PASS = "AC-1: met — a\nAC-2: met — b";

const evidence = (headSha: string): MergeEvidence => ({
  review: {
    reviewerRunId: "run-review",
    reviewerAgentId: "reviewer",
    headSha,
    baseSha: "9".repeat(40),
    verdict: "pass",
    body: PASS,
  },
  authorRunIds: ["run-impl"],
  authorAgentIds: ["impl"],
  unresolvedMandatoryFindings: 0,
  workflowGatesPassed: true,
});

function setup(
  options: {
    merge?: MergeBaseResult;
    reviewedHeads?: string[];
    dirty?: boolean;
    checkStatus?: CheckRunRecord["status"];
    configured?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const written: { path: string; text: string }[] = [];
  const reviewed = options.reviewedHeads ?? [OLD];
  const sync: BranchSync = {
    facts: (commit): CarryFacts => ({
      head: commit,
      parents: [],
      secondParentOnBase: false,
      headTree: TREE,
      mergeTree: null,
    }),
    mergeBase: () => {
      calls.push("merge");
      return (
        options.merge ?? {
          kind: "merged",
          oldHead: OLD,
          newHead: NEW,
          mergeTree: TREE,
          baseCommit: BASE,
        }
      );
    },
    push: () => {
      calls.push("push");
    },
  };
  const checks: CheckRunner = {
    has: () => options.configured ?? true,
    run: (request) => {
      calls.push(`check:${request.checkId}`);
      return Promise.resolve({
        checkId: request.checkId,
        status: options.checkStatus ?? "passed",
        exitCode: 0,
        command: ["npm", "run", "check"],
        startedAt: "2026-11-12T00:00:00.000Z",
        endedAt: "2026-11-12T00:00:01.000Z",
        revision: NEW,
        evidence: {
          path: `${request.artifactRoot}/checks/${request.checkId}.json`,
          sha256: "e".repeat(64),
        },
      });
    },
  };
  const workspace = {
    inspect: () => ({
      ok: true as const,
      value: {
        path: "/w",
        headSha: OLD,
        branch: "task/x",
        dirty: options.dirty ?? false,
        hasIgnoredFiles: false,
      },
    }),
  } as unknown as GitWorkspace;
  const deps = {
    evidence: {
      read: (_p: string, _t: string, head: string) =>
        reviewed.includes(head) ? evidence(head) : { ...evidence(head), review: undefined },
    },
    workspace,
    sync,
    checks,
    artifacts: {
      write: (input: { path: string; bytes: Uint8Array }) => {
        written.push({ path: input.path, text: new TextDecoder().decode(input.bytes) });
        return { path: input.path, sha256: "f".repeat(64) };
      },
      read: () => new Uint8Array(),
      manifest: () => ({ schemaVersion: 1 as const, artifacts: [] }),
    },
    now: () => Date.parse("2026-11-12T00:00:02.000Z"),
    nextId: () => "artifact-1",
  };
  return { deps, calls, written };
}

const input = {
  projectId: "project-1",
  taskId: "task-1",
  worktreePath: "/w",
  requiredChecks: ["check"],
  artifactRoot: "attempts/attempt-1",
  attemptId: "attempt-1",
};

describe("carryPassOverSync", () => {
  it("merges base, re-runs the required checks, pushes and records the carried PASS", async () => {
    const s = setup();
    const result = await carryPassOverSync(s.deps, input);
    expect(result).toMatchObject({
      status: "carried",
      record: { oldHeadSha: OLD, newHeadSha: NEW },
    });
    expect(s.calls).toEqual(["merge", "check:check", "push"]);
    expect(s.written).toHaveLength(1);
    expect(s.written[0]?.path).toBe(`attempts/attempt-1/carried-pass/${NEW}.json`);
    expect(JSON.parse(s.written[0]?.text ?? "{}")).toMatchObject({
      oldHeadSha: OLD,
      newHeadSha: NEW,
      baseCommit: BASE,
      mergeTree: TREE,
      checks: [{ checkId: "check", status: "passed", revision: NEW }],
    });
  });

  it("refuses a conflict, lists the files and records and pushes nothing", async () => {
    const s = setup({ merge: { kind: "conflict", files: ["src/a.ts", "src/b.ts"] } });
    expect(await carryPassOverSync(s.deps, input)).toEqual({
      status: "refused",
      reasons: ["MERGE_CONFLICT"],
      conflictedFiles: ["src/a.ts", "src/b.ts"],
    });
    expect(s.calls).toEqual(["merge"]);
    expect(s.written).toEqual([]);
  });

  it.each(["failed", "timed-out"] as const)(
    "records nothing and pushes nothing when a required check %s on the new head",
    async (checkStatus) => {
      const s = setup({ checkStatus });
      expect(await carryPassOverSync(s.deps, input)).toMatchObject({
        status: "refused",
        reasons: ["CHECK_NOT_PASSED:check"],
      });
      expect(s.calls).toEqual(["merge", "check:check"]);
      expect(s.written).toEqual([]);
    },
  );

  it("refuses a head without a PASS before touching git", async () => {
    const s = setup({ reviewedHeads: [] });
    expect(await carryPassOverSync(s.deps, input)).toMatchObject({
      status: "refused",
      reasons: ["NO_VALID_PASS"],
    });
    expect(s.calls).toEqual([]);
  });

  it("refuses a dirty worktree and a check the runtime cannot run, before merging", async () => {
    const dirty = setup({ dirty: true });
    expect(await carryPassOverSync(dirty.deps, input)).toMatchObject({
      reasons: ["WORKTREE_DIRTY"],
    });
    const unconfigured = setup({ configured: false });
    expect(await carryPassOverSync(unconfigured.deps, input)).toMatchObject({
      reasons: ["CHECK_UNCONFIGURED:check"],
    });
    expect([...dirty.calls, ...unconfigured.calls]).toEqual([]);
  });

  it("changes nothing when the branch already contains the base", async () => {
    const s = setup({ merge: { kind: "up-to-date", head: OLD } });
    expect(await carryPassOverSync(s.deps, input)).toEqual({ status: "up-to-date" });
    expect(s.calls).toEqual(["merge"]);
    expect(s.written).toEqual([]);
  });
});
