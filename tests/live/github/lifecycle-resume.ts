// Pure "already done, skip" decisions so the live lifecycle harness can continue after a stop.
// Gates are never relaxed: a skip needs GitHub to show the same head the review/PO approved.
interface ResumePull {
  readonly number: number;
  readonly state: string;
  readonly merged: boolean;
  readonly headSha: string;
  readonly baseRef: string;
  readonly mergeCommitSha: string | null;
}

export type TaskResume =
  | { readonly action: "run" }
  | { readonly action: "skip"; readonly prNumber: number; readonly mergeCommitSha: string };

export function decideTaskResume(input: {
  readonly reviewedHeadSha: string;
  readonly pull?: ResumePull | undefined;
  readonly onDevelop?: boolean | undefined;
}): TaskResume {
  const { pull } = input;
  if (pull === undefined || pull.state === "open") return { action: "run" };
  if (!pull.merged) throw new Error(`mapped PR #${String(pull.number)} closed without merge`);
  if (pull.headSha !== input.reviewedHeadSha)
    throw new Error(`mapped PR #${String(pull.number)} head differs from the reviewed head`);
  if (pull.baseRef !== "develop")
    throw new Error(`mapped PR #${String(pull.number)} did not merge into develop`);
  if (pull.mergeCommitSha === null || input.onDevelop !== true)
    throw new Error(`merge commit of PR #${String(pull.number)} is not on develop`);
  return { action: "skip", prNumber: pull.number, mergeCommitSha: pull.mergeCommitSha };
}

export type ReleaseResume =
  { readonly action: "wait" } | { readonly action: "skip"; readonly mergeCommitSha: string };

export function decideReleaseResume(input: {
  readonly pull: ResumePull;
  readonly onMain?: boolean | undefined;
  readonly reviews: readonly { actor: string; state: string; commitSha: string }[];
  readonly poActors: readonly string[];
}): ReleaseResume {
  const { pull } = input;
  if (pull.state === "open") return { action: "wait" };
  if (!pull.merged) throw new Error(`release PR #${String(pull.number)} closed without merge`);
  const po = input.poActors.map((a) => a.toLowerCase());
  const latest = input.reviews
    .filter((r) => po.includes(r.actor.toLowerCase()) && r.commitSha === pull.headSha)
    .at(-1);
  if (latest?.state !== "APPROVED")
    throw new Error(`release PR #${String(pull.number)} merged without PO approval on its head`);
  if (pull.baseRef !== "main" || pull.mergeCommitSha === null || input.onMain !== true)
    throw new Error(`merge commit of release PR #${String(pull.number)} is not on main`);
  return { action: "skip", mergeCommitSha: pull.mergeCommitSha };
}
