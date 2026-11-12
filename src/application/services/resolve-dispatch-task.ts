import { acceptanceCriteria } from "../../domain/tasks/acceptance-criteria.js";
import type { ApprovalRequest } from "../../domain/approvals/approval.js";
import { relativePathSchema } from "../contracts/identifiers.js";
import { contextPacketSchema } from "../contracts/context.js";
import { taskComplexitySchema } from "../contracts/task-complexity.js";
import { DispatchPlanningError } from "./dispatch-planning-error.js";
import type { DispatchPlanningRefusal } from "./dispatch-planning-error.js";
import type { DispatchTask } from "./plan-step-dispatch.js";

export { DispatchPlanningError, type DispatchPlanningRefusal };

/** Pure Markdown parsing: only the Implementation map section contributes scope. */
export function implementationPaths(body: string): readonly string[] {
  const paths: string[] = [];
  let active = false;
  let fence: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter !== undefined) {
      if (fence === undefined) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    if (/^##[ \t]+Implementation map[ \t]*$/i.test(line)) {
      active = true;
      continue;
    }
    if (/^#{1,2}[ \t]+/.test(line)) {
      active = false;
      continue;
    }
    if (!active) continue;
    const marked = [...line.matchAll(/`([^`]+)`|\[[^\]]+\]\(([^)]+)\)/g)].map(
      (match) => match[1] ?? match[2] ?? "",
    );
    const candidates =
      marked.length > 0 ? marked : line.replace(/^\s*[-*+]\s+/, "").split(/[\s,;]+/);
    for (const path of candidates) {
      if (
        relativePathSchema.safeParse(path).success &&
        !/[{}<>*?:]/.test(path) &&
        (path.includes("/") || /\.[a-z0-9]+$/i.test(path))
      )
        paths.push(path);
    }
  }
  return [...new Set(paths)];
}

export function resolveDispatchTask(input: {
  readonly taskId: string;
  readonly issue: unknown;
  readonly approvals: readonly ApprovalRequest[];
  readonly now: number;
  readonly complexity?: unknown;
}): DispatchTask {
  const issue = contextPacketSchema.shape.taskSnapshot.parse(input.issue);
  const paths = implementationPaths(issue.body);
  if (paths.length === 0) throw new DispatchPlanningError("IMPLEMENTATION_MAP_EMPTY");
  const keys = [...issue.body.matchAll(/<!--\s*omi-squad:plan-key=(OMI-\d{3,})\s*-->/g)].map(
    (match) => match[1],
  );
  const planKey = keys[0];
  if (planKey === undefined || new Set(keys).size !== 1)
    throw new DispatchPlanningError("PLAN_KEY_REQUIRED");
  const approval = input.approvals.find(
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
  if (approval === undefined) throw new DispatchPlanningError("BUSINESS_APPROVAL_REQUIRED");
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
  now: () => number,
) {
  const tasks = new Map<string, DispatchTask>();
  return {
    current: (taskId: string) => tasks.get(taskId),
    async read(taskId: string): Promise<DispatchTask> {
      const sourceTask = await source.read(taskId);
      if (sourceTask === undefined) throw new DispatchPlanningError("TASK_NOT_FOUND");
      const task = resolveDispatchTask({ taskId, ...sourceTask, now: now() });
      tasks.set(taskId, task);
      return task;
    },
  };
}
