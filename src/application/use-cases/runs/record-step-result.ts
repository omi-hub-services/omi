import { z } from "zod";
import { transitionAgentAttempt } from "../../../domain/runs/agent-attempt.js";
import type { AgentAttemptStatus } from "../../../domain/runs/agent-attempt.js";
import { transitionStep } from "../../../domain/runs/step-run.js";
import type { StepStatus } from "../../../domain/runs/step-run.js";
import { executionResultSchema } from "../../contracts/agent-execution.js";
import { artifactPathSchema } from "../../contracts/artifact.js";
import { identifierSchema } from "../../contracts/identifiers.js";
import { stepResultSchema } from "../../contracts/result.js";
import type { StepResult } from "../../contracts/result.js";
import type { AttemptStore, StepRunReader } from "../../ports/attempt-store.js";
import { ArtifactError } from "../../ports/artifact-store.js";
import type { ArtifactStore } from "../../ports/artifact-store.js";
import type { BoundaryCheckpointHook } from "../../ports/checkpoint-hook.js";
import type { GitWorkspace } from "../../ports/git-workspace.js";
import type { StateUnitOfWork } from "../../ports/state-unit-of-work.js";

const recordStepResultSchema = z.strictObject({
  attemptId: identifierSchema,
  /** What the adapter observed about the process. Never enough on its own for Done. */
  execution: executionResultSchema,
  /** The worker's structured claim, still untrusted JSON. Absent when the worker produced none. */
  result: z.unknown().optional(),
});
export type RecordStepResultInput = z.input<typeof recordStepResultSchema>;

export interface RecordStepResultDependencies {
  readonly attempts: AttemptStore;
  readonly steps: StepRunReader;
  readonly artifacts: ArtifactStore;
  readonly workspaces: GitWorkspace;
  readonly unitOfWork: StateUnitOfWork;
  /** Business checkpoint after the output is confirmed (OMI-026); absent means none is taken. */
  readonly checkpoint?: BoundaryCheckpointHook;
  readonly now: () => number;
  readonly nextId: () => string;
}

/** Nothing was written: the event is stale, unknown, or the state layer refused it. */
export type RecordStepRefusal =
  | "INVALID_INPUT"
  | "ATTEMPT_NOT_FOUND"
  | "STEP_NOT_FOUND"
  /** A newer attempt exists for the step. */
  | "STALE_ATTEMPT"
  /** The worker's revision is not the workspace's current head. */
  | "STALE_REVISION"
  | "ATTEMPT_NOT_RUNNING"
  | "STEP_NOT_RUNNING"
  | "EXECUTION_MISMATCH"
  | "WORKSPACE_UNAVAILABLE"
  | "STATE_REJECTED";

/** The attempt and step were recorded as failed for this reason. */
export type StepFailureReason =
  | "EXECUTION_FAILED"
  | "RESULT_MISSING"
  | "RESULT_INVALID"
  | "RESULT_MISMATCH"
  | "WORKER_REPORTED_FAILURE"
  | "PATH_OUTSIDE_ROOT"
  | "ARTIFACT_INVALID"
  | "ARTIFACT_HASH_MISMATCH"
  | "REVISION_MISSING"
  | "REQUIRED_CHECK_MISSING";

export type RecordStepResult =
  | {
      readonly ok: true;
      readonly stepStatus: Extract<StepStatus, "succeeded" | "failed">;
      readonly attemptStatus: Extract<AgentAttemptStatus, "succeeded" | "failed">;
      readonly failure?: StepFailureReason;
      /** Set only when a checkpoint hook is wired and it failed; the step outcome still stands. */
      readonly checkpointFailure?: string;
    }
  | { readonly ok: false; readonly reason: RecordStepRefusal; readonly detail?: string };

/**
 * Accepts a worker's structured result only after the runtime has checked it: schema, ids, that
 * every path stays inside the attempt's artifact root, that artifacts exist with the claimed
 * hash, the revision, and the checks the step gate needs. Only then does the step succeed.
 * A process that exited 0 without a valid result fails the step. An event from an older attempt
 * or revision is refused and never overwrites newer state.
 */
export function recordStepResult(
  deps: RecordStepResultDependencies,
  input: unknown,
): RecordStepResult {
  const parsed = recordStepResultSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const { attemptId, execution, result } = parsed.data;

  const attempt = deps.attempts.get(attemptId);
  if (attempt === undefined) return { ok: false, reason: "ATTEMPT_NOT_FOUND" };
  const step = deps.steps.get(attempt.stepRunId);
  if (step === undefined) return { ok: false, reason: "STEP_NOT_FOUND" };
  const latest = deps.attempts.latestForStep(step.id);
  if (latest === undefined || latest.attemptNumber !== attempt.attemptNumber) {
    return { ok: false, reason: "STALE_ATTEMPT" };
  }
  if (attempt.status !== "running") return { ok: false, reason: "ATTEMPT_NOT_RUNNING" };
  if (step.status !== "running") return { ok: false, reason: "STEP_NOT_RUNNING" };
  if (execution.attemptId !== attempt.id || execution.executor !== attempt.executor) {
    return { ok: false, reason: "EXECUTION_MISMATCH" };
  }

  const verdict = verify(deps, attempt, execution.outcome, result);
  if ("refusal" in verdict) {
    return {
      ok: false,
      reason: verdict.refusal,
      ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
    };
  }
  const failure = "failure" in verdict ? verdict.failure : undefined;

  const succeeded = failure === undefined;
  // The process has finished, so the writer is stopped. Staleness beyond the attempt number is
  // caught by the lease fence and the step version in the same transaction.
  const generation = attempt.workspace.generation;
  const stepOutcome = transitionStep(
    step.status,
    succeeded
      ? {
          type: "succeed",
          attempt: attempt.attemptNumber,
          currentAttempt: latest.attemptNumber,
          resultValid: true,
          stepGatePassed: true,
        }
      : { type: "fail", attempt: attempt.attemptNumber, currentAttempt: latest.attemptNumber },
  );
  const attemptOutcome = transitionAgentAttempt("running", {
    type: succeeded ? "succeed" : "fail",
    generation,
    currentGeneration: generation,
    writerStopped: true,
    resultValid: succeeded,
  });
  if (!stepOutcome.ok) return { ok: false, reason: "STATE_REJECTED", detail: stepOutcome.reason };
  if (!attemptOutcome.ok) {
    return { ok: false, reason: "STATE_REJECTED", detail: attemptOutcome.reason };
  }
  if (
    (stepOutcome.to !== "succeeded" && stepOutcome.to !== "failed") ||
    (attemptOutcome.to !== "succeeded" && attemptOutcome.to !== "failed")
  ) {
    return { ok: false, reason: "STATE_REJECTED", detail: "TRANSITION_NOT_ALLOWED" };
  }

  const committed = deps.unitOfWork.commit({
    target: {
      kind: "step_run",
      id: step.id,
      expectedVersion: step.version,
      toStatus: stepOutcome.to,
    },
    at: new Date(deps.now()).toISOString(),
    event: {
      eventId: deps.nextId(),
      kind: `step.${stepOutcome.to}`,
      subject: step.id,
      runId: step.runId,
      correlationId: attempt.id,
      payload: JSON.stringify({
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        outcome: execution.outcome,
        exitCode: execution.exitCode,
        ...(failure === undefined ? {} : { failure }),
        ...("report" in verdict ? { result: verdict.report } : {}),
      }),
    },
    fence: {
      resourceKey: attempt.workspace.leaseKey,
      owner: attempt.workspace.owner,
      generation,
    },
  });
  if (!committed.ok) return { ok: false, reason: "STATE_REJECTED", detail: committed.reason };

  deps.attempts.setStatus(attempt.id, attemptOutcome.to);
  deps.workspaces.releaseWriter({
    taskId: attempt.workspace.taskId,
    slug: attempt.workspace.slug,
    owner: attempt.workspace.owner,
    generation,
    now: new Date(deps.now()).toISOString(),
  });
  // The writer is released and the outcome is committed: this is the confirmed-output boundary.
  // The outcome cannot be undone, so a failed checkpoint is reported, not turned into a refusal.
  const checkpoint = deps.checkpoint?.({
    kind: "after-output",
    runId: step.runId,
    stepRunId: step.id,
    stepId: step.stepId,
    attemptId: attempt.id,
    workspacePath: attempt.workspace.path,
    outputs: succeeded && "report" in verdict ? verdict.report.artifacts : [],
  });
  return {
    ok: true,
    stepStatus: stepOutcome.to,
    attemptStatus: attemptOutcome.to,
    ...(failure === undefined ? {} : { failure }),
    ...(checkpoint === undefined || checkpoint.ok ? {} : { checkpointFailure: checkpoint.reason }),
  };
}

type Verdict =
  | { readonly accepted: true; readonly report: StepResult }
  | { readonly failure: StepFailureReason; readonly report?: StepResult }
  | { readonly refusal: RecordStepRefusal; readonly detail?: string };

function verify(
  deps: RecordStepResultDependencies,
  attempt: NonNullable<ReturnType<AttemptStore["get"]>>,
  outcome: string,
  raw: unknown,
): Verdict {
  // Exit code and process outcome describe the process only; a structured result is still needed.
  if (outcome !== "succeeded") return { failure: "EXECUTION_FAILED" };
  if (raw === undefined) return { failure: "RESULT_MISSING" };
  const parsed = stepResultSchema.safeParse(raw);
  if (!parsed.success) return { failure: "RESULT_INVALID" };
  const report = parsed.data;
  if (
    report.runId !== attempt.runId ||
    report.stepId !== attempt.stepId ||
    report.attemptId !== attempt.id
  ) {
    return { failure: "RESULT_MISMATCH" };
  }
  if (report.status !== "succeeded") return { failure: "WORKER_REPORTED_FAILURE", report };

  const prefix = `${attempt.artifactRoot}/`;
  const paths = [
    ...report.artifacts.map((artifact) => artifact.path),
    ...report.checks.map((check) => check.evidenceRef),
  ];
  if (
    !paths.every((path) => artifactPathSchema.safeParse(path).success && path.startsWith(prefix))
  ) {
    return { failure: "PATH_OUTSIDE_ROOT", report };
  }
  try {
    deps.artifacts.manifest(report.artifacts);
  } catch (error) {
    if (!(error instanceof ArtifactError)) throw error;
    return {
      failure: error.code === "HASH_MISMATCH" ? "ARTIFACT_HASH_MISMATCH" : "ARTIFACT_INVALID",
      report,
    };
  }

  if (report.revision === undefined) {
    if (attempt.access === "workspace-write") return { failure: "REVISION_MISSING", report };
  } else {
    const state = deps.workspaces.inspect(attempt.workspace.path);
    if (!state.ok) return { refusal: "WORKSPACE_UNAVAILABLE", detail: state.error.code };
    if (state.value.headSha !== report.revision.headSha) return { refusal: "STALE_REVISION" };
  }

  const reported = new Set(report.checks.map((check) => check.id));
  if (!attempt.requiredChecks.every((id) => reported.has(id))) {
    return { failure: "REQUIRED_CHECK_MISSING", report };
  }
  return { accepted: true, report };
}
