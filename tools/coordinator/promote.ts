// Pure selection rules of `flow.ts promote` (ADR-0014): which Backlog Issue may become Ready.
// Shared by flow.ts (promote) and status.ts ("Backlog, all blockers closed"); no I/O here.
import { issueReadinessReasons, type IssueReadiness } from "./issue-readiness.ts";
import {
  partitionByStatus,
  type Blocker,
  type ProjectItem,
  type ReadyTask,
} from "./github-snapshot.ts";

export interface PromoteInput extends IssueReadiness {
  readonly status: string | null;
  readonly blockers: readonly Blocker[];
  /** More blockers exist than were fetched; treated as blocked. */
  readonly blockersTruncated: boolean;
}

export type Promotion =
  | { readonly kind: "promote" }
  | { readonly kind: "done"; readonly note: string }
  | { readonly kind: "refuse"; readonly reason: string };

/** Verdict for one Issue: promote it, report it already Ready, or refuse with every reason. */
export function judgePromotion(number: number, issue: PromoteInput): Promotion {
  const id = `#${String(number)}`;
  if (issue.workType === "Epic") return { kind: "refuse", reason: `${id} is an Epic` };
  if (issue.status === "Ready") return { kind: "done", note: `${id} Status is already Ready` };
  if (issue.status !== "Backlog") {
    return { kind: "refuse", reason: `${id} is ${issue.status ?? "(none)"}, not Backlog` };
  }
  const reasons: string[] = [];
  const open = issue.blockers
    .filter((b) => b.state !== "CLOSED")
    .map((b) => `#${String(b.number)}`);
  if (open.length > 0) reasons.push(`blocked by ${open.join(", ")}`);
  else if (issue.blockersTruncated) reasons.push("more blockers than could be read");
  reasons.push(...issueReadinessReasons(issue));
  return reasons.length > 0
    ? { kind: "refuse", reason: `${id}: ${reasons.join("; ")}` }
    : { kind: "promote" };
}

/**
 * Backlog Issues that `promote` would accept, in status.ts priority order (Priority, milestone,
 * Issue number): every blocker closed and passing the readiness gate. The first is the pick.
 */
export function promotableBacklog(items: readonly ProjectItem[]): ReadyTask[] {
  return partitionByStatus(items, "Backlog").unblocked.filter(
    (r) => issueReadinessReasons(r.item).length === 0,
  );
}
