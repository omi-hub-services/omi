// Git reads behind a carried PASS (OMI-069): the facts carried-pass.ts judges. Read-only apart
// from `git merge-tree --write-tree`, which only adds tree objects. Goes through the injectable
// runner and a GitCommand, so the same reads serve WSL and a local clone.
import { BASE_BRANCH } from "./coordinator-settings.ts";
import {
  judgeCarriedHead,
  parseMergeTree,
  type CarryFacts,
  type CarryJudgement,
} from "./carried-pass.ts";
import type { GitCommand } from "./git-probe.ts";
import { agentReviewOn } from "./github-snapshot.ts";
import type { AuthoredComment } from "./json-shape.ts";
import { runChecked, type Runner } from "./process-runner.ts";

/** A carried PASS can itself be carried again (every later sync); bound the walk anyway. */
const MAX_HOPS = 20;

/** Parents, develop membership, tree and automatic-merge tree of `commit`. */
export async function readCarryFacts(
  run: Runner,
  git: GitCommand,
  commit: string,
): Promise<CarryFacts> {
  const line = (await runChecked(run, git(["rev-list", "--parents", "-n", "1", commit]))).trim();
  const [head = "", ...parents] = line.split(/\s+/);
  const headTree = (await runChecked(run, git(["show", "-s", "--format=%T", head]))).trim();
  const [first, second] = parents;
  if (parents.length !== 2 || first === undefined || second === undefined) {
    return { head, parents, secondParentOnDevelop: false, headTree, mergeTree: null };
  }
  const [onDevelop, merge] = await Promise.all([
    run(git(["merge-base", "--is-ancestor", second, `origin/${BASE_BRANCH}`])),
    run(git(["merge-tree", "--write-tree", "--name-only", first, second])),
  ]);
  if (onDevelop.code !== 0 && onDevelop.code !== 1) {
    throw new Error(`git merge-base exited ${String(onDevelop.code)}: ${onDevelop.stderr.trim()}`);
  }
  const tree = parseMergeTree(merge.code, merge.stdout, merge.stderr);
  return {
    head,
    parents,
    secondParentOnDevelop: onDevelop.code === 0,
    headTree,
    mergeTree: tree.clean ? tree.tree : null,
  };
}

/**
 * Walks the carried PASSes from `sha` back to a PASS that was posted by a review (no
 * `CARRIED_FROM`); every hop must be a clean sync in git. A missing or non-PASS review, a bad
 * hop, a commit git cannot read, or a walk past MAX_HOPS makes the answer "not ok".
 */
export async function judgeCarryChain(
  run: Runner,
  git: GitCommand,
  comments: readonly AuthoredComment[],
  sha: string,
): Promise<CarryJudgement> {
  let at = sha;
  let developCommit = "";
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const review = agentReviewOn(comments, at);
    if (review?.verdict !== "PASS") {
      const seen = review ? review.verdict : "no review";
      return { ok: false, reason: `no Coordinator PASS on ${at.slice(0, 7)} (${seen})` };
    }
    if (review.carriedFrom === null) return { ok: true, developCommit };
    let facts: CarryFacts;
    try {
      facts = await readCarryFacts(run, git, at);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `cannot read ${at.slice(0, 7)} from git (${reason})` };
    }
    const judged = judgeCarriedHead(facts, review.carriedFrom);
    if (!judged.ok) return judged;
    if (developCommit === "") developCommit = judged.developCommit;
    at = facts.parents[0] ?? "";
  }
  return { ok: false, reason: `carried PASS chain is longer than ${String(MAX_HOPS)} syncs` };
}
