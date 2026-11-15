/**
 * Carrying a review PASS over a clean sync with the base branch (OMI-080, ADR-0014 rule 069).
 * A carried PASS is trusted from git facts, never from stored text: the head must be the
 * automatic merge of the reviewed commit and a commit of the base branch, tree for tree.
 */

/** What git says about one commit that claims to carry a PASS. */
export interface CarryFacts {
  readonly head: string;
  readonly parents: readonly string[];
  /** The second parent is an ancestor of (or equal to) the base branch. */
  readonly secondParentOnBase: boolean;
  readonly headTree: string;
  /** Tree of the automatic merge of both parents; null when that merge conflicts. */
  readonly mergeTree: string | null;
}

export type CarryJudgement =
  | { readonly ok: true; readonly baseCommit: string }
  | { readonly ok: false; readonly reason: string };

const sha7 = (sha: string): string => sha.slice(0, 7);
const fail = (reason: string): CarryJudgement => ({ ok: false, reason });

/** Is `facts.head` a clean sync of `carriedFrom` (full or abbreviated SHA) with the base? */
export function judgeCarriedHead(facts: CarryFacts, carriedFrom: string): CarryJudgement {
  const at = sha7(facts.head);
  const [first, second] = facts.parents;
  if (first === undefined || second === undefined || facts.parents.length !== 2) {
    return fail(`${at} is not a merge commit (${String(facts.parents.length)} parents)`);
  }
  if (!first.startsWith(carriedFrom)) {
    return fail(`first parent of ${at} is ${sha7(first)}, not the reviewed ${sha7(carriedFrom)}`);
  }
  if (!facts.secondParentOnBase) {
    return fail(`second parent ${sha7(second)} of ${at} is not on the base branch`);
  }
  if (facts.mergeTree === null) {
    return fail(`merging ${sha7(first)} with ${sha7(second)} conflicts, so ${at} is not automatic`);
  }
  if (facts.mergeTree !== facts.headTree) {
    return fail(
      `tree of ${at} differs from the automatic merge of ${sha7(first)} and ${sha7(second)}`,
    );
  }
  return { ok: true, baseCommit: second };
}
