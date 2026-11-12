import { describe, expect, it } from "vitest";
import * as bootstrap from "../../../../../src/bootstrap/container.ts";
import { preparationHarness } from "./prepare-pr-fakes.ts";
import { sha256ContentHasher } from "../../../../../src/infrastructure/artifacts/sha256-content-hasher.ts";
import type { MergePull } from "../../../../../src/application/contracts/merge-delivery.ts";

const head = "a".repeat(40);
const body = `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\`\nAC-1: met — test`;
function setup() {
  const h = preparationHarness();
  const pull: MergePull = {
    number: 42,
    repository: "acme/app",
    state: "open",
    merged: false,
    headSha: head,
    headRef: "task/example",
    baseRef: "develop",
    author: "worker",
    mergeableState: "clean",
    mergeCommitSha: null,
    body: "Issue: #7",
  };
  const deps = {
    ...h.deps,
    repository: "acme/app",
    hasher: sha256ContentHasher,
    reader: {
      pull: () => Promise.resolve(pull),
      issue: () =>
        Promise.resolve({
          number: 7,
          state: "open" as const,
          body: "## Acceptance criteria\n- [ ] Works\n  - [ ] Nested\n### Notes\n- [ ] Not an AC",
        }),
    },
  };
  return { h, deps, pull };
}
describe("post review comment", () => {
  it("posts once through the outbox on repeated requests", async () => {
    const { h, deps } = setup();
    const post = bootstrap.createReviewCommentUseCase(deps);
    expect(await post({ prNumber: 42, body })).toMatchObject({ ok: true, status: "succeeded" });
    expect(await post({ prNumber: 42, body })).toMatchObject({ ok: true, status: "succeeded" });
    expect(h.github.sends).toHaveLength(1);
    expect(h.github.sends[0]?.operation).toEqual({
      type: "issue.comment",
      repo: "acme/app",
      issueNumber: 42,
      body,
    });
  });
  it("refuses a stale review before queuing any write", async () => {
    const { h, deps, pull } = setup();
    pull.headSha = "b".repeat(40);
    expect(await bootstrap.createReviewCommentUseCase(deps)({ prNumber: 42, body })).toMatchObject({
      ok: false,
      reason: "REVIEWED_HEAD_MISMATCH",
    });
    expect(h.outbox.records.size).toBe(0);
  });
  it("refuses ambiguous Issue links", async () => {
    const { h, deps, pull } = setup();
    pull.body = "Issue: #7\nIssue: #8";
    expect(await bootstrap.createReviewCommentUseCase(deps)({ prNumber: 42, body })).toMatchObject({
      ok: false,
      reason: "ISSUE_LINK_REQUIRED",
    });
    expect(h.outbox.records.size).toBe(0);
  });
});
