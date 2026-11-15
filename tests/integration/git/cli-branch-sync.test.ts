import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MergeEvidence } from "../../../src/application/contracts/merge-delivery.ts";
import type { CheckRunner } from "../../../src/application/ports/check-runner.ts";
import { carryPassOverSync } from "../../../src/application/use-cases/delivery/carry-pass-over-sync.ts";
import { resolveCarriedEvidence } from "../../../src/application/services/resolve-carried-review.ts";
import { judgeCarriedHead } from "../../../src/domain/delivery/carried-pass-policy.ts";
import { createCliBranchSync } from "../../../src/infrastructure/git/cli-branch-sync.ts";

const BRANCH = "task/omi-080-x";
let root = "";
let origin = "";
let work = "";
let other = "";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
const commit = (cwd: string, file: string, text: string): string => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
  return git(cwd, "rev-parse", "HEAD");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omi-carry-"));
  origin = join(root, "origin.git");
  work = join(root, "work");
  other = join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "develop", origin);
  git(root, "clone", "-q", origin, work);
  commit(work, "shared.txt", "1\n2\n3\n");
  git(work, "push", "-q", "origin", "develop");
  git(root, "clone", "-q", origin, other);
  git(work, "checkout", "-q", "-b", BRANCH);
  commit(work, "feature.txt", "feature\n");
  git(work, "push", "-q", "origin", BRANCH);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const pushBase = (file: string, text: string): string => {
  const sha = commit(other, file, text);
  git(other, "push", "-q", "origin", "develop");
  return sha;
};

describe("cli branch sync (real git)", () => {
  it("merges a clean develop into the branch; the result is judged a clean sync", () => {
    const base = pushBase("other.txt", "from develop\n");
    const reviewed = git(work, "rev-parse", "HEAD");
    const sync = createCliBranchSync({ repositoryPath: work, baseBranch: "develop" });

    const merged = sync.mergeBase(work);
    expect(merged).toMatchObject({ kind: "merged", oldHead: reviewed, baseCommit: base });
    if (merged.kind !== "merged") return;
    expect(git(work, "rev-parse", "HEAD")).toBe(merged.newHead);
    expect(git(work, "rev-parse", "HEAD^{tree}")).toBe(merged.mergeTree);
    expect(judgeCarriedHead(sync.facts(merged.newHead), reviewed)).toEqual({
      ok: true,
      baseCommit: base,
    });
  });

  it("refuses a hand-edited merge: the same parents with another tree are not a clean sync", () => {
    pushBase("other.txt", "from develop\n");
    const reviewed = git(work, "rev-parse", "HEAD");
    git(work, "fetch", "-q", "origin", "develop");
    git(work, "merge", "-q", "--no-ff", "--no-commit", "origin/develop");
    writeFileSync(join(work, "sneaky.txt"), "not in either parent\n");
    git(work, "add", "sneaky.txt");
    git(work, "commit", "-q", "-m", "merge with a hand edit");
    const sync = createCliBranchSync({ repositoryPath: work, baseBranch: "develop" });
    const judged = judgeCarriedHead(sync.facts(git(work, "rev-parse", "HEAD")), reviewed);
    expect(judged.ok).toBe(false);
    expect(judged.ok ? "" : judged.reason).toContain("differs from the automatic merge");
  });

  it("lists the conflicted files and leaves the branch and worktree untouched", () => {
    commit(work, "shared.txt", "1\nbranch\n3\n");
    git(work, "push", "-q", "origin", BRANCH);
    pushBase("shared.txt", "1\nbase\n3\n");
    const head = git(work, "rev-parse", "HEAD");
    const sync = createCliBranchSync({ repositoryPath: work, baseBranch: "develop" });

    expect(sync.mergeBase(work)).toEqual({ kind: "conflict", files: ["shared.txt"] });
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(git(work, "status", "--porcelain")).toBe("");
  });

  it("reports up-to-date when develop is already in the branch", () => {
    const sync = createCliBranchSync({ repositoryPath: work, baseBranch: "develop" });
    expect(sync.mergeBase(work)).toMatchObject({ kind: "up-to-date" });
  });

  it("pushes the branch to origin without force", () => {
    pushBase("other.txt", "x\n");
    const sync = createCliBranchSync({ repositoryPath: work, baseBranch: "develop" });
    const merged = sync.mergeBase(work);
    sync.push(work);
    expect(git(origin, "rev-parse", BRANCH)).toBe(merged.kind === "merged" ? merged.newHead : "");
  });

  it("rejects a commit argument that is not a full SHA", () => {
    const sync = createCliBranchSync({ repositoryPath: work, baseBranch: "develop" });
    expect(() => sync.facts("--output=x")).toThrow("INVALID_INPUT");
  });
});

describe("carry a PASS over a sync (real git, local bare origin)", () => {
  const evidenceFor = (
    reviewed: string,
  ): { read: (p: string, t: string, h: string) => MergeEvidence } => ({
    read: (_p, _t, head) => ({
      ...(head === reviewed
        ? {
            review: {
              reviewerRunId: "run-review",
              reviewerAgentId: "reviewer",
              headSha: head,
              baseSha: "9".repeat(40),
              verdict: "pass" as const,
              body: "AC-1: met — a",
            },
          }
        : {}),
      authorRunIds: ["run-impl"],
      authorAgentIds: ["impl"],
      unresolvedMandatoryFindings: 0,
      workflowGatesPassed: true,
    }),
  });
  const run = (reviewed: string, checkPasses: boolean) => {
    const sync = createCliBranchSync({ repositoryPath: work, baseBranch: "develop" });
    const written: string[] = [];
    const checks: CheckRunner = {
      has: () => true,
      run: (request) =>
        Promise.resolve({
          checkId: request.checkId,
          status: checkPasses ? "passed" : "failed",
          exitCode: checkPasses ? 0 : 1,
          command: ["npm", "run", "check"],
          startedAt: "2026-11-12T00:00:00.000Z",
          endedAt: "2026-11-12T00:00:01.000Z",
          revision: git(work, "rev-parse", "HEAD"),
          evidence: { path: "a/checks/check.json", sha256: "e".repeat(64) },
        }),
    };
    const deps = {
      evidence: evidenceFor(reviewed),
      workspace: {
        inspect: () => ({
          ok: true as const,
          value: {
            path: work,
            headSha: git(work, "rev-parse", "HEAD"),
            branch: BRANCH,
            dirty: git(work, "status", "--porcelain") !== "",
            hasIgnoredFiles: false,
          },
        }),
      },
      sync,
      checks,
      artifacts: {
        write: (input: { path: string }) => {
          written.push(input.path);
          return { path: input.path, sha256: "f".repeat(64) };
        },
        read: () => new Uint8Array(),
        manifest: () => ({ schemaVersion: 1 as const, artifacts: [] }),
      },
      now: () => Date.parse("2026-11-12T00:00:02.000Z"),
      nextId: () => "artifact-1",
    };
    const input = {
      projectId: "project-1",
      taskId: "task-1",
      worktreePath: work,
      requiredChecks: ["check"],
      artifactRoot: "attempts/attempt-1",
      attemptId: "attempt-1",
    };
    return { deps, input, sync, written };
  };

  it("carries the PASS over a clean merge: pushed, recorded, and the gate resolves it", async () => {
    const base = pushBase("other.txt", "from develop\n");
    const reviewed = git(work, "rev-parse", "HEAD");
    const { deps, input, sync, written } = run(reviewed, true);

    const result = await carryPassOverSync(deps, input);
    expect(result).toMatchObject({ status: "carried", record: { oldHeadSha: reviewed } });
    const newHead = git(work, "rev-parse", "HEAD");
    expect(git(origin, "rev-parse", BRANCH)).toBe(newHead);
    expect(written).toEqual([`attempts/attempt-1/carried-pass/${newHead}.json`]);
    expect(resolveCarriedEvidence(deps, "project-1", "task-1", newHead).review).toMatchObject({
      headSha: newHead,
      baseSha: base,
      verdict: "pass",
    });
    expect(sync.facts(newHead).parents).toEqual([reviewed, base]);
  });

  it("refuses a conflict, names the files and pushes and records nothing", async () => {
    commit(work, "shared.txt", "1\nbranch\n3\n");
    git(work, "push", "-q", "origin", BRANCH);
    pushBase("shared.txt", "1\nbase\n3\n");
    const reviewed = git(work, "rev-parse", "HEAD");
    const { deps, input, written } = run(reviewed, true);

    expect(await carryPassOverSync(deps, input)).toEqual({
      status: "refused",
      reasons: ["MERGE_CONFLICT"],
      conflictedFiles: ["shared.txt"],
    });
    expect(git(origin, "rev-parse", BRANCH)).toBe(reviewed);
    expect(written).toEqual([]);
  });

  it("does not push or record when the check fails on the merged head", async () => {
    pushBase("other.txt", "from develop\n");
    const reviewed = git(work, "rev-parse", "HEAD");
    const { deps, input, written } = run(reviewed, false);

    expect(await carryPassOverSync(deps, input)).toMatchObject({
      status: "refused",
      reasons: ["CHECK_NOT_PASSED:check"],
    });
    expect(git(origin, "rev-parse", BRANCH)).toBe(reviewed);
    expect(written).toEqual([]);
  });
});
