import { z } from "zod";
import { validRegressionEvidence } from "../../services/validate-review-evidence.js";
import {
  acceptanceReviewRefusals,
  parseAcReviewLines,
} from "../../../domain/delivery/acceptance-review.js";
import { contextPacketSchema } from "../../contracts/context.js";
import { selectReviewBody } from "../../services/build-run-merge-evidence.js";
import { transitionAgentAttempt } from "../../../domain/runs/agent-attempt.js";
import type { AgentAttemptStatus } from "../../../domain/runs/agent-attempt.js";
import { transitionStep } from "../../../domain/runs/step-run.js";
import type { StepStatus } from "../../../domain/runs/step-run.js";
import { executionResultSchema } from "../../contracts/agent-execution.js";
import { artifactPathSchema, artifactReferenceSchema } from "../../contracts/artifact.js";
import type { ArtifactReference } from "../../contracts/artifact.js";
import { checkRunRecordSchema } from "../../contracts/check-run.js";
import type { CheckRunRecord } from "../../contracts/check-run.js";
import { gitShaSchema, identifierSchema } from "../../contracts/identifiers.js";
import { stepResultSchema } from "../../contracts/result.js";
import type { StepResult } from "../../contracts/result.js";
import type { AttemptStore, StepRunReader } from "../../ports/attempt-store.js";
import { ArtifactError } from "../../ports/artifact-store.js";
import type { ArtifactAdopter, ArtifactStore } from "../../ports/artifact-store.js";
import type { BoundaryCheckpointHook } from "../../ports/checkpoint-hook.js";
import type { CheckRunner } from "../../ports/check-runner.js";
import type { GitWorkspace } from "../../ports/git-workspace.js";
import type { StateUnitOfWork } from "../../ports/state-unit-of-work.js";

const recordStepResultSchema = z.strictObject({
  attemptId: identifierSchema,
  /** What the adapter observed about the process. Never enough on its own for Done. */
  execution: executionResultSchema,
  /** The worker's structured claim, still untrusted JSON. Absent when the worker produced none. */
  result: z.unknown().optional(),
  /** What the runtime itself observed when it ran the step's required checks (OMI-085). */
  checkRuns: z.array(checkRunRecordSchema).default([]),
  /** The `regression-test` artifact the runtime's own script wrote; a worker's claim never counts. */
  regressionEvidence: artifactReferenceSchema.optional(),
});
export type RecordStepResultInput = z.input<typeof recordStepResultSchema>;

export interface RecordStepResultDependencies {
  readonly attempts: AttemptStore;
  readonly steps: StepRunReader;
  readonly artifacts: ArtifactStore & ArtifactAdopter;
  readonly workspaces: GitWorkspace;
  readonly unitOfWork: StateUnitOfWork;
  /**
   * Says which required check ids the runtime runs itself. Those pass only through a matching
   * run in the input; any other id is still accepted from the worker's evidence (OMI-085).
   */
  readonly checks?: Pick<CheckRunner, "has">;
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
  /** Local and origin develop diverged, so the review base cannot be determined. */
  | "INTEGRATION_REF_DIVERGED"
  | "REQUIRED_CHECK_MISSING"
  /** A check the runtime runs has no run in the input. */
  | "CHECK_NOT_RUN"
  | "CHECK_FAILED"
  | "CHECK_TIMED_OUT"
  /** The runtime's check ran on another revision than the worker reported. */
  | "CHECK_REVISION_MISMATCH"
  /** The attempt was given a skill the result does not report as applied. */
  | "SKILL_EVIDENCE_MISSING"
  /** The result reports a skill the attempt was not given. */
  | "SKILL_NOT_ASSIGNED"
  | "REVIEW_AC_LINES_INVALID"
  | "REGRESSION_EVIDENCE_INVALID";

export type RecordStepResult =
  | {
      readonly ok: true;
      readonly stepStatus: Extract<StepStatus, "succeeded" | "failed">;
      readonly attemptStatus: Extract<AgentAttemptStatus, "succeeded" | "failed">;
      readonly failure?: StepFailureReason;
      readonly detail?: string;
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
  const { attemptId, execution, result, checkRuns, regressionEvidence } = parsed.data;

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

  const verdict = verify(deps, attempt, execution.outcome, result, checkRuns, regressionEvidence);
  if ("refusal" in verdict) {
    return {
      ok: false,
      reason: verdict.refusal,
      ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
    };
  }
  const failure = "failure" in verdict ? verdict.failure : undefined;
  const detail = "detail" in verdict ? verdict.detail : undefined;

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
        ...(detail === undefined ? {} : { detail }),
        ...(checkRuns.length === 0
          ? {}
          : {
              checkRuns: checkRuns.map(({ checkId, status, revision }) => ({
                checkId,
                status,
                revision,
              })),
            }),
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
    outputs: "accepted" in verdict ? verdict.report.artifacts : [],
  });
  return {
    ok: true,
    stepStatus: stepOutcome.to,
    attemptStatus: attemptOutcome.to,
    ...(failure === undefined ? {} : { failure }),
    ...(detail === undefined ? {} : { detail }),
    ...(checkpoint === undefined || checkpoint.ok ? {} : { checkpointFailure: checkpoint.reason }),
  };
}

/** An accepted result: artifacts carry the runtime's hashes and the revision is the runtime's own. */
type VerifiedResult = Omit<StepResult, "artifacts" | "revision"> & {
  readonly artifacts: ArtifactReference[];
  readonly revision: { readonly headSha: string; readonly baseSha: string } | undefined;
};

type Verdict =
  | { readonly accepted: true; readonly report: VerifiedResult }
  | { readonly failure: StepFailureReason; readonly report?: StepResult; readonly detail?: string }
  | { readonly refusal: RecordStepRefusal; readonly detail?: string };

function verify(
  deps: RecordStepResultDependencies,
  attempt: NonNullable<ReturnType<AttemptStore["get"]>>,
  outcome: string,
  raw: unknown,
  checkRuns: readonly CheckRunRecord[],
  regressionEvidence: ArtifactReference | undefined,
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
    ...report.skillsApplied.map((skill) => skill.evidenceRef),
  ];
  if (
    !paths.every((path) => artifactPathSchema.safeParse(path).success && path.startsWith(prefix))
  ) {
    return { failure: "PATH_OUTSIDE_ROOT", report };
  }
  let artifacts: ArtifactReference[];
  try {
    // The runtime hashes what the worker wrote; a hash the worker claimed must agree with it.
    artifacts = report.artifacts.map((claimed) => {
      const adopted = deps.artifacts.adopt({
        id: deps.nextId(),
        path: claimed.path,
        producerAttemptId: attempt.id,
        classification: "worker-output",
        createdAt: new Date(deps.now()).toISOString(),
      });
      if (claimed.sha256 !== undefined && claimed.sha256 !== adopted.sha256) {
        throw new ArtifactError("HASH_MISMATCH");
      }
      return adopted;
    });
    const manifest = deps.artifacts.manifest(artifacts);
    // Runtime check evidence is verified below; skill evidence must be worker-declared.
    const hasEvidence = (evidenceRef: string) =>
      manifest.artifacts.some((artifact) => artifact.path === evidenceRef && artifact.size > 0);
    if (
      !report.checks.every(
        (check) =>
          hasEvidence(check.evidenceRef) ||
          checkRuns.some(
            (run) => run.checkId === check.id && run.evidence.path === check.evidenceRef,
          ),
      ) ||
      !report.skillsApplied.every((skill) => hasEvidence(skill.evidenceRef))
    )
      return { failure: "ARTIFACT_INVALID", report };
    if (attempt.role.id === "reviewer") {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const packet = contextPacketSchema.safeParse(
        JSON.parse(decoder.decode(deps.artifacts.read(attempt.contextPacket))) as unknown,
      );
      if (!packet.success) return { failure: "ARTIFACT_INVALID", report };
      const body = selectReviewBody(
        artifacts.map((artifact) => decoder.decode(deps.artifacts.read(artifact))),
        report.summary,
      );
      const refusals = acceptanceReviewRefusals(
        packet.data.acceptanceCriteria.length,
        parseAcReviewLines(body),
      ).filter((reason) => reason !== "AC_NOT_MET");
      if (refusals.length > 0) {
        return { failure: "REVIEW_AC_LINES_INVALID", detail: refusals.join(","), report };
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return { failure: "ARTIFACT_INVALID", report };
    }
    if (!(error instanceof ArtifactError)) throw error;
    return {
      failure: error.code === "HASH_MISMATCH" ? "ARTIFACT_HASH_MISMATCH" : "ARTIFACT_INVALID",
      report,
    };
  }

  // The revision is the runtime's own view of the worktree. The worker's value is only a claim:
  // absent or malformed (a worker without a shell) is ignored, a well-formed different head is stale;
  // the base always comes from the runtime.
  const claim = report.revision;
  const claimedSha = (value: string | undefined) =>
    value !== undefined && gitShaSchema.safeParse(value).success ? value : undefined;
  const state = deps.workspaces.inspect(attempt.workspace.path);
  let revision: { headSha: string; baseSha: string } | undefined;
  if (!state.ok) {
    if (attempt.access === "workspace-write" || claimedSha(claim?.headSha) !== undefined) {
      return { refusal: "WORKSPACE_UNAVAILABLE", detail: state.error.code };
    }
  } else {
    const headSha = state.value.headSha;
    const base = deps.workspaces.mergeBase?.(attempt.workspace.path);
    const claimedHead = claimedSha(claim?.headSha);
    if (claimedHead !== undefined && claimedHead !== headSha) return { refusal: "STALE_REVISION" };
    // The base is never taken from the worker. Merge evidence needs one, so without the runtime's
    // own merge-base the result fails closed.
    if (base?.ok === false && base.error.code === "INTEGRATION_REF_DIVERGED")
      return { failure: "INTEGRATION_REF_DIVERGED", report };
    if (base?.ok !== true) return { failure: "REVISION_MISSING", report };
    revision = { headSha, baseSha: base.value };
  }
  // Setting revision explicitly (even to undefined) drops the worker's claim.
  const verified: VerifiedResult = { ...report, artifacts, revision };

  // regression-test is run by its own script (below), never as a plain check or on a worker's word.
  const runtimeChecks = attempt.requiredChecks.filter(
    (id) => id !== "regression-test" && (id === "project-check" || deps.checks?.has(id) === true),
  );
  // The worker's own check list is informational for these ids; only the runtime's run counts.
  const reported = new Set(report.checks.map((check) => check.id));
  const evidenceChecks = attempt.requiredChecks.filter(
    (id) => id !== "regression-test" && !runtimeChecks.includes(id),
  );
  if (!evidenceChecks.every((id) => reported.has(id))) {
    return { failure: "REQUIRED_CHECK_MISSING", report };
  }
  const checkFailure = verifyRuntimeChecks(deps, attempt, verified, runtimeChecks, checkRuns);
  if (checkFailure !== undefined) return { failure: checkFailure, report };

  if (attempt.requiredChecks.includes("regression-test")) {
    try {
      if (
        regressionEvidence === undefined ||
        !regressionEvidence.path.startsWith(`${attempt.artifactRoot}/`) ||
        !validRegressionEvidence(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              deps.artifacts.read(regressionEvidence),
            ),
          ) as unknown,
          revision?.baseSha ?? "",
          revision?.headSha ?? "",
        )
      )
        return { failure: "REGRESSION_EVIDENCE_INVALID", report };
    } catch {
      return { failure: "REGRESSION_EVIDENCE_INVALID", report };
    }
  }

  // The worker saw exactly the manifest's skills (inlined at dispatch); it must account for each.
  const given = new Set(attempt.skills.map((skill) => skill.id));
  const applied = new Set(report.skillsApplied.map((skill) => skill.id));
  if (![...applied].every((id) => given.has(id))) return { failure: "SKILL_NOT_ASSIGNED", report };
  if (![...given].every((id) => applied.has(id))) {
    return { failure: "SKILL_EVIDENCE_MISSING", report };
  }
  return { accepted: true, report: verified };
}

/** Every check the runtime runs must have passed, on the worker's revision, with stored evidence. */
function verifyRuntimeChecks(
  deps: RecordStepResultDependencies,
  attempt: NonNullable<ReturnType<AttemptStore["get"]>>,
  report: VerifiedResult,
  ids: readonly string[],
  runs: readonly CheckRunRecord[],
): StepFailureReason | undefined {
  for (const id of ids) {
    const run = runs.find((candidate) => candidate.checkId === id);
    if (run === undefined) return "CHECK_NOT_RUN";
    if (run.status === "timed-out") return "CHECK_TIMED_OUT";
    if (run.status !== "passed" || run.exitCode !== 0) return "CHECK_FAILED";
    if (run.revision !== report.revision?.headSha) return "CHECK_REVISION_MISMATCH";
    if (!run.evidence.path.startsWith(`${attempt.artifactRoot}/`)) return "PATH_OUTSIDE_ROOT";
    try {
      if (!deps.artifacts.manifest([run.evidence]).artifacts.every((entry) => entry.size > 0)) {
        return "ARTIFACT_INVALID";
      }
    } catch (error) {
      if (!(error instanceof ArtifactError)) throw error;
      return error.code === "HASH_MISMATCH" ? "ARTIFACT_HASH_MISMATCH" : "ARTIFACT_INVALID";
    }
  }
  return undefined;
}
