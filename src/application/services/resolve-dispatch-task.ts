import { acceptanceCriteria } from "../../domain/tasks/acceptance-criteria.js";
import { evaluateExecutionApprovals } from "../../domain/approvals/approval-policy.js";
import type { ApprovalRequest, ApprovalSubject } from "../../domain/approvals/approval.js";
import { approvalSubjectSchema } from "../contracts/approval.js";
import type { ApprovalSubjectReader } from "../ports/approval-store.js";
import { implementationPaths } from "../../domain/tasks/implementation-map.js";
import { PLAN_KEY_PATTERN, planKeyMarkers } from "../../domain/tasks/plan-key.js";
import { contextPacketSchema } from "../contracts/context.js";
import { taskComplexitySchema } from "../contracts/task-complexity.js";
import { DispatchPlanningError } from "./dispatch-planning-error.js";
import type { DispatchPlanningRefusal } from "./dispatch-planning-error.js";
import type { DispatchTask } from "./plan-step-dispatch.js";

export { DispatchPlanningError, type DispatchPlanningRefusal };

export { implementationPaths };

export function resolveDispatchTask(input: {
  readonly taskId: string;
  readonly issue: unknown;
  readonly approvals: readonly ApprovalRequest[];
  readonly now: number;
  /** Business subject of the imported task snapshot read just now (ADR-0037); absent fails closed. */
  readonly current: ApprovalSubject | undefined;
  readonly complexity?: unknown;
}): DispatchTask {
  const issue = contextPacketSchema.shape.taskSnapshot.parse(input.issue);
  const paths = implementationPaths(issue.body);
  if (paths.length === 0) throw new DispatchPlanningError("IMPLEMENTATION_MAP_EMPTY");
  const keys = planKeyMarkers(issue.body);
  const planKey = keys[0];
  if (planKey === undefined || keys.length !== 1 || !PLAN_KEY_PATTERN.test(planKey))
    throw new DispatchPlanningError("PLAN_KEY_REQUIRED");
  const current = input.current;
  if (current === undefined) throw new DispatchPlanningError("BUSINESS_APPROVAL_REQUIRED");
  const candidates = input.approvals.filter(
    (request) =>
      request.status === "approved" &&
      request.subject.kind === "business" &&
      request.subject.scopeIds.includes(input.taskId) &&
      request.decision?.decision === "approved" &&
      request.decision.subject.kind === "business" &&
      request.subjectHash === request.subject.baselineHash &&
      request.decision.subject.baselineHash === request.subjectHash &&
      (request.expiresAt === undefined || request.expiresAt > input.now) &&
      (request.decision.expiresAt === undefined || request.decision.expiresAt > input.now),
  );
  // The approval must still authorise the CURRENT imported revision (domain policy decides).
  // The actor was allowlisted when the decision was recorded; re-checking it here is not this gate.
  const verdicts = candidates.map((request) => ({
    request,
    decision: evaluateExecutionApprovals([
      {
        request,
        expected: {
          subject: current,
          allowedActors: request.decision === undefined ? [] : [request.decision.actor],
          now: input.now,
        },
      },
    ]),
  }));
  const approval = verdicts.find(({ decision }) => decision.allowed)?.request;
  if (approval === undefined) {
    const stale = verdicts.some(
      ({ decision }) => !decision.allowed && decision.reasons.includes("STALE_REVISION"),
    );
    throw new DispatchPlanningError(
      stale ? "BUSINESS_APPROVAL_STALE" : "BUSINESS_APPROVAL_REQUIRED",
    );
  }
  return {
    context: {
      taskSnapshot: issue,
      acceptanceCriteria: [...acceptanceCriteria(issue.body)],
      businessBaselineHash: approval.subjectHash,
      inputArtifacts: [],
      previousFindings: [],
      allowedScope: { paths: [...paths] },
      approvalRefs: [approval.id],
    },
    complexity: taskComplexitySchema.parse(input.complexity),
    workspace: { taskId: planKey.toLowerCase(), slug: planKey.toLowerCase() },
  };
}

/** A successful read can supply the synchronous checkpoint boundary in the same session. */
export function createDispatchTaskReader(
  source: import("../ports/dispatch-task-source.js").DispatchTaskSource,
  subjects: ApprovalSubjectReader,
  now: () => number,
) {
  const tasks = new Map<string, DispatchTask>();
  return {
    current: (taskId: string) => tasks.get(taskId),
    async read(taskId: string): Promise<DispatchTask> {
      const sourceTask = await source.read(taskId);
      if (sourceTask === undefined) throw new DispatchPlanningError("TASK_NOT_FOUND");
      // Read after the (async) source so the revision is as fresh as the approvals compared to it.
      const parsed = approvalSubjectSchema.safeParse(subjects.read(taskId, "business"));
      const task = resolveDispatchTask({
        taskId,
        ...sourceTask,
        now: now(),
        current: parsed.success ? parsed.data : undefined,
      });
      tasks.set(taskId, task);
      return task;
    },
  };
}
