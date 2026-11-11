// Carrying an agent review PASS over a clean sync with develop (OMI-069, ADR-0014). Pure
// decisions only: the git reads live in carry-git.ts. A carried PASS is trusted from git facts,
// never from the comment text: the head must be the automatic merge of the reviewed commit and a
// commit of origin/develop, byte for byte (tree equal to `git merge-tree --write-tree`).
import { BASE_BRANCH } from "./coordinator-settings.ts";
import { acLines } from "./acceptance-criteria.ts";
import type { AgentReview } from "./github-snapshot.ts";
import type { AuthoredComment } from "./json-shape.ts";

/** What git says about one commit that claims to carry a PASS (see carry-git.ts). */
export interface CarryFacts {
  readonly head: string;
  readonly parents: readonly string[];
  /** The second parent is an ancestor of (or equal to) origin/develop. */
  readonly secondParentOnDevelop: boolean;
  readonly headTree: string;
  /** Tree of `git merge-tree --write-tree <parent1> <parent2>`; null when that merge conflicts. */
  readonly mergeTree: string | null;
}

export type CarryJudgement =
  | { readonly ok: true; readonly developCommit: string }
  | { readonly ok: false; readonly reason: string };

const sha7 = (sha: string) => sha.slice(0, 7);
const fail = (reason: string): CarryJudgement => ({ ok: false, reason });

/** Is `facts.head` a clean sync of `carriedFrom` (full or abbreviated SHA) with develop? */
export function judgeCarriedHead(facts: CarryFacts, carriedFrom: string): CarryJudgement {
  const at = sha7(facts.head);
  const [first, second] = facts.parents;
  if (first === undefined || second === undefined || facts.parents.length !== 2) {
    return fail(`${at} is not a merge commit (${String(facts.parents.length)} parents)`);
  }
  if (!first.startsWith(carriedFrom)) {
    return fail(`first parent of ${at} is ${sha7(first)}, not the reviewed ${sha7(carriedFrom)}`);
  }
  if (!facts.secondParentOnDevelop) {
    return fail(`second parent ${sha7(second)} of ${at} is not on origin/${BASE_BRANCH}`);
  }
  if (facts.mergeTree === null) {
    return fail(`merging ${sha7(first)} with ${sha7(second)} conflicts, so ${at} is not automatic`);
  }
  if (facts.mergeTree !== facts.headTree) {
    return fail(
      `tree of ${at} differs from the automatic merge of ${sha7(first)} and ${sha7(second)}` +
        ` (edited by hand or a conflict resolution)`,
    );
  }
  return { ok: true, developCommit: second };
}

/** One-line wording of a refused carried PASS, shared by merge and close. */
export function wrongHeadCarry(
  review: Pick<AgentReview, "head" | "carriedFrom">,
  judgement: CarryJudgement | undefined,
): string {
  const from = sha7(review.carriedFrom ?? "");
  const why = judgement === undefined ? "not verified" : judgement.ok ? "" : judgement.reason;
  return `wrong-head PASS: PASS @${sha7(review.head)} carried from ${from} is not a clean sync with ${BASE_BRANCH} (${why})`;
}

// ── git merge-tree ───────────────────────────────────────────────────────────
export type MergeTree =
  | { readonly clean: true; readonly tree: string }
  | { readonly clean: false; readonly files: readonly string[] };

/**
 * Output of `git merge-tree --write-tree --name-only`: exit 0 prints the tree, exit 1 prints a
 * tree and the conflicted paths up to the first blank line (messages follow). Anything else
 * is an error, not a conflict.
 */
export function parseMergeTree(code: number, stdout: string, stderr = ""): MergeTree {
  const lines = stdout.split("\n");
  const tree = lines[0]?.trim() ?? "";
  if (code !== 0 && code !== 1) {
    throw new Error(`git merge-tree exited ${String(code)}: ${stderr.trim().slice(0, 300)}`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(`git merge-tree printed no tree: ${tree}`);
  if (code === 0) return { clean: true, tree };
  const blank = lines.indexOf("", 1);
  const files = lines.slice(1, blank === -1 ? undefined : blank).filter(Boolean);
  return { clean: false, files: [...new Set(files)] };
}

export function conflictRefusal(branch: string, files: readonly string[]): string {
  const list = files.length > 0 ? files.join(", ") : "(none listed)";
  return (
    `origin/${BASE_BRANCH} does not merge cleanly into ${branch}; conflicted files: ${list}. ` +
    `Resolve them and have the reviewer check only the resolution (ADR-0014)`
  );
}

// ── sync ─────────────────────────────────────────────────────────────────────
export interface SyncState {
  readonly branch: string;
  /** `--reviewed`, as given (full or abbreviated). */
  readonly reviewed: string;
  readonly current: string;
  readonly head: string;
  readonly clean: boolean;
  readonly remote: string | null;
  /** The open PR of the branch into develop, or null. */
  readonly pull: { readonly number: number; readonly comments: readonly AuthoredComment[] } | null;
  /** origin/develop is already an ancestor of the head. */
  readonly developInHead: boolean;
  /** The newest Coordinator review of the PR (any commit), or null. */
  readonly newest: AgentReview | null;
  /** The newest review on `reviewed` is a PASS whose carry chain (if any) holds in git. */
  readonly reviewedPass: CarryJudgement;
  /** head is a clean sync of `reviewed`; null when head is `reviewed` itself. */
  readonly headCarry: CarryJudgement | null;
  /** The newest review on head is a PASS whose carry chain holds; null when none is on head. */
  readonly headPass: CarryJudgement | null;
}

export type SyncDecision =
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "done"; readonly note: string }
  /** head is `reviewed`: merge origin/develop, check, push, comment. */
  | { readonly kind: "merge" }
  /**
   * The merge commit exists locally but check, push or the comment is missing; `commented` when
   * the PASS on head is already posted (only the push is left).
   */
  | { readonly kind: "resume"; readonly commented: boolean };

const refuse = (reason: string): SyncDecision => ({ kind: "refuse", reason });

export function decideSync(s: SyncState): SyncDecision {
  const at = sha7(s.reviewed);
  if (s.current !== s.branch) return refuse(`WSL checkout is on ${s.current}, not ${s.branch}`);
  if (!s.clean) return refuse("WSL checkout has uncommitted or untracked changes");
  if (s.pull === null) return refuse(`no open PR from ${s.branch} into ${BASE_BRANCH}`);
  const sameHead = s.head.startsWith(s.reviewed);
  if (!sameHead) {
    // Re-run after a successful (or interrupted) sync: head is the merge of `reviewed`.
    if (s.headCarry === null || !s.headCarry.ok) {
      const why = s.headCarry?.ok === false ? `: ${s.headCarry.reason}` : "";
      return refuse(`${s.branch} is at ${sha7(s.head)}, not the reviewed ${at}${why}`);
    }
    if (s.headPass?.ok === true) {
      return s.remote === s.head
        ? { kind: "done", note: `PASS on ${at} is already carried to ${sha7(s.head)} and pushed` }
        : { kind: "resume", commented: true };
    }
    if (!s.reviewedPass.ok) {
      return refuse(`no valid Coordinator PASS on ${at} (${s.reviewedPass.reason})`);
    }
    return { kind: "resume", commented: false };
  }
  if (s.remote !== s.head) {
    return refuse(`origin/${s.branch} is at ${sha7(s.remote ?? "none")}, not the reviewed ${at}`);
  }
  if (s.newest?.verdict !== "PASS" || !s.head.startsWith(s.newest.head)) {
    const seen = s.newest ? `${s.newest.verdict} @${sha7(s.newest.head)}` : "none";
    return refuse(`newest Coordinator review is not a PASS on ${at} (newest: ${seen})`);
  }
  if (!s.reviewedPass.ok) return refuse(`no valid PASS on ${at} (${s.reviewedPass.reason})`);
  if (s.developInHead) {
    return {
      kind: "done",
      note: `${s.branch} already contains origin/${BASE_BRANCH}; PASS stands`,
    };
  }
  return { kind: "merge" };
}

// ── comment ──────────────────────────────────────────────────────────────────
export interface CarriedComment {
  readonly newHead: string;
  readonly reviewed: string;
  readonly oldReviewBody: string;
  readonly developCommit: string;
  readonly checkNote: string;
}

/** The comment `sync` posts as the Coordinator: header, evidence and the old AC lines. */
export function carriedComment(c: CarriedComment): string {
  const lines = acLines(c.oldReviewBody);
  return [
    `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${c.newHead}\` · **CARRIED_FROM:** \`${c.reviewed}\``,
    "",
    `Carried over a clean sync with origin/${BASE_BRANCH}; no new review (ADR-0014, OMI-069).`,
    "",
    `- Merge commit: \`${c.newHead}\` (parent 1 \`${c.reviewed}\`)`,
    `- origin/${BASE_BRANCH} commit merged in: \`${c.developCommit}\``,
    `- Check: ${c.checkNote}`,
    "",
    ...lines,
    "",
  ].join("\n");
}
