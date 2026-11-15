import { transitionRework } from "../../../domain/runs/rework-policy.js";
import type { ReworkState } from "../../../domain/runs/rework-policy.js";
import type { RunStatus } from "../../../domain/runs/workflow-run.js";
import { transitionRun } from "../../../domain/runs/workflow-run.js";
import { recordReworkEventSchema, reworkRecordSchema } from "../../contracts/rework.js";
import type { ProjectSession } from "../../ports/lease-store.js";
import type { ReworkRunReader } from "../../ports/rework-run-reader.js";
import { PROJECT_OWNER_LEASE_KEY } from "../../services/claim-project-session.js";
import type { ReworkApprovalDependencies } from "../../services/check-rework-approval.js";
import { checkReworkApproval } from "../../services/check-rework-approval.js";

export interface RecordReworkEventDependencies {
  readonly runs: ReworkRunReader;
  readonly session: ProjectSession;
  /** Save the failure history before blocking. Caller supplies the existing checkpoint use case
   * and confirms writers have stopped; a failed checkpoint leaves the quality state untouched.
   */
  readonly checkpoint: (
    runId: string,
    state: ReworkState,
  ) => { readonly ok: true; readonly checkpointId: string } | { readonly ok: false };
  readonly nextId: () => string;
  readonly approvals?: ReworkApprovalDependencies;
}

export type ReworkAction = "retry" | "architect_required" | "blocked" | "passed";
export type RecordReworkEventResult =
  | { readonly ok: true; readonly state: ReworkState; readonly action: ReworkAction }
  | { readonly ok: false; readonly reason: string };

/** Public boundary excludes internal cycle/gate events and caller-attested approval flags. */
export async function recordReworkDecision(
  deps: RecordReworkEventDependencies,
  input: unknown,
): Promise<RecordReworkEventResult> {
  const parsed = reworkRecordSchema.safeParse(input);
  return parsed.success
    ? recordReworkEvent(deps, parsed.data)
    : { ok: false, reason: "INVALID_INPUT" };
}

/** Runtime-only quality boundary. The Coordinator dispatches an Architect on architect_required,
 * supplies its accepted intervention, then authorizes another quality cycle. A stable cycleId
 * belongs to the implement/fix round: review and check FAIL for that round use the same id.
 * This never dispatches workers, changes scope, or spends the operational retry budget.
 */
export async function recordReworkEvent(
  deps: RecordReworkEventDependencies,
  input: unknown,
): Promise<RecordReworkEventResult> {
  const parsed = recordReworkEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  if (deps.session.lease.resourceKey !== PROJECT_OWNER_LEASE_KEY || !deps.session.renew())
    return { ok: false, reason: "PROJECT_LOCK_LOST" };
  const { runId, event } = parsed.data;
  const run = deps.runs.get(runId);
  if (run === undefined) return { ok: false, reason: "RUN_NOT_FOUND" };
  if (run.status !== "running" && !(run.status === "blocked" && event.type === "po_reopened"))
    return { ok: false, reason: "RUN_NOT_RUNNING" };
  if (
    event.type === "po_reopened" ||
    (event.type === "architect_solution_accepted" && event.changesBusinessOrCost)
  ) {
    const decisionId = event.poDecisionId;
    if (deps.approvals === undefined || decisionId === undefined)
      return { ok: false, reason: "APPROVAL_REQUIRED" };
    const approved = await checkReworkApproval(deps.approvals, run, decisionId);
    if (!approved.ok) return approved;
    if (!deps.session.renew()) return { ok: false, reason: "PROJECT_LOCK_LOST" };
    if (deps.runs.get(runId)?.version !== run.version)
      return { ok: false, reason: "STALE_VERSION" };
  }
  const authorizedEvent =
    event.type === "architect_solution_accepted" ? { ...event, approvalValid: true } : event;
  const outcome = transitionRework(run.rework, authorizedEvent);
  if (!outcome.ok) return outcome;
  const state = outcome.state;
  let status: RunStatus = run.status;
  let checkpointId: string | undefined;
  if (state.phase === "blocked") {
    const checkpoint = deps.checkpoint(runId, state);
    if (!checkpoint.ok) return { ok: false, reason: "CHECKPOINT_FAILED" };
    checkpointId = checkpoint.checkpointId;
    const blocked = transitionRun(status, { type: "block", checkpointSaved: true });
    if (!blocked.ok) return blocked;
    status = blocked.to;
  } else if (event.type === "po_reopened") {
    const reopened = transitionRun(status, { type: "reopen", poDecisionId: event.poDecisionId });
    if (!reopened.ok) return reopened;
    status = reopened.to;
  }
  const action: ReworkAction =
    state.phase === "architect"
      ? "architect_required"
      : state.phase === "blocked"
        ? "blocked"
        : state.phase === "passed"
          ? "passed"
          : "retry";
  const committed = deps.session.commit({
    target: {
      kind: "workflow_run",
      id: run.id,
      expectedVersion: run.version,
      toStatus: status,
      rework: state,
    },
    event: {
      eventId: deps.nextId(),
      kind: `rework.${action}`,
      subject: run.taskId,
      runId,
      correlationId: runId,
      payload: JSON.stringify({ event, state, action, checkpointId }),
    },
  });
  return committed.ok ? { ok: true, state, action } : { ok: false, reason: committed.reason };
}
