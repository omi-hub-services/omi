import type { MergeEvidence } from "../contracts/merge-delivery.js";
import type { BranchSync } from "../ports/branch-sync.js";
import type { MergeEvidenceReader } from "../ports/merge-delivery.js";
import { judgeCarriedHead } from "../../domain/delivery/carried-pass-policy.js";

/** A carried PASS can itself be carried again by every later sync; bound the walk anyway. */
const MAX_HOPS = 20;

/**
 * The delivery evidence for `headSha`, with a PASS carried from an earlier head when `headSha`
 * is a chain of clean syncs with the base branch (OMI-080). Every hop is judged from git, never
 * from stored text. Anything else (no review, a FAIL, a hand-edited or conflicting merge, a commit
 * git cannot read, a chain past MAX_HOPS) leaves the review absent, so the merge gate refuses.
 */
export function resolveCarriedEvidence(
  deps: { readonly evidence: MergeEvidenceReader; readonly sync: Pick<BranchSync, "facts"> },
  projectId: string,
  taskId: string,
  headSha: string,
): MergeEvidence {
  const atHead = deps.evidence.read(projectId, taskId, headSha);
  const absent: MergeEvidence = { ...atHead, review: undefined };
  let at = headSha;
  let baseSha: string | undefined;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const direct = deps.evidence.read(projectId, taskId, at).review;
    if (direct?.headSha === at) {
      if (at === headSha) return atHead;
      if (direct.verdict !== "pass" || baseSha === undefined) return absent;
      return { ...atHead, review: { ...direct, headSha, baseSha } };
    }
    try {
      const facts = deps.sync.facts(at);
      const parent = facts.parents[0] ?? "";
      const judged = judgeCarriedHead(facts, parent);
      if (!judged.ok) return absent;
      baseSha ??= judged.baseCommit;
      at = parent;
    } catch {
      return absent;
    }
  }
  return absent;
}
