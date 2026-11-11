import { z } from "zod";
import type { SelectionResult } from "../../../domain/agents/selection-policy.js";
import { transitionProfile } from "../../../domain/profiles/profile-state.js";
import type { RegisteredProfile } from "../../../domain/profiles/profile-metadata.js";
import { decideOperationalRetry, type RetryBudget } from "../../../domain/runs/retry-policy.js";
import { transitionStep } from "../../../domain/runs/step-run.js";
import { executionResultSchema } from "../../contracts/agent-execution.js";
import type { CheckpointManifest } from "../../contracts/checkpoint.js";
import { identifierSchema, slugSchema } from "../../contracts/identifiers.js";
import { executorSchema, modelsConfigSchema } from "../../contracts/model-capability.js";
import { effortPolicySchema, taskComplexitySchema } from "../../contracts/task-complexity.js";
import type { StepRunRecord } from "../../ports/attempt-store.js";
import type { ExecutorSelectionStore } from "../../ports/executor-selection-store.js";
import type { ProfileRegistry } from "../../ports/profile-registry.js";
import { PROJECT_OWNER_LEASE_KEY } from "../../services/claim-project-session.js";
import { quiesceRunWorkers, type QuiesceRefusal } from "../../services/quiesce-run-workers.js";
import { resumeRun, type ResumeRunDependencies, type ResumeRunResult } from "../runs/resume-run.js";
import { selectExecutor } from "./select-executor.js";

type SelectedCandidate = Extract<SelectionResult, { outcome: "selected" }>;

/** What the dispatcher is told to start: the profile that selection chose and reserved. */
export interface FailoverSelection {
  /** Reserved by selection; the dispatcher must reuse it (`dispatchStep.reservedAttemptId`). */
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly candidate: SelectedCandidate["candidate"];
  readonly effort: SelectedCandidate["effort"];
  /** Isolated profile directory of the chosen profile (never a credential). */
  readonly profileHome: string;
}

export type FailoverDispatch = (request: {
  readonly checkpoint: CheckpointManifest;
  readonly step: StepRunRecord;
  readonly selection: FailoverSelection;
}) => Promise<
  | { readonly ok: true; readonly attemptId: string }
  | { readonly ok: false; readonly reason: string }
>;

export interface FailoverStepDependencies extends Omit<ResumeRunDependencies, "dispatch"> {
  readonly profiles: ProfileRegistry;
  readonly selections: ExecutorSelectionStore;
  /** Bound to dispatchStep with the executor adapter of `selection.candidate.executor`. */
  readonly dispatch: FailoverDispatch;
  /** Operational budget (retry-policy.ts); it is never the quality budget of rework-policy.ts. */
  readonly retryBudget: RetryBudget;
  /** Random value in [0, 1) that spreads the fallback cooldown. */
  readonly jitter: () => number;
}

const failoverStepSchema = z.strictObject({
  runId: identifierSchema,
  stepRunId: identifierSchema,
  capabilityProfile: slugSchema,
  /** A step that must run on one tool; the capability profile may also declare it. */
  requiredExecutor: executorSchema.optional(),
  models: modelsConfigSchema,
  task: taskComplexitySchema,
  effortPolicy: effortPolicySchema,
  /** The failed attempt's result. Required while the step is `running`; a step already in
   * `waiting_resource` is re-entered without it once a resource may be back. */
  execution: executionResultSchema.optional(),
  /** Failovers already made for this step; the caller owns this operational counter. */
  failoversMade: z.number().int().nonnegative().default(0),
});

export type FailoverRefusal =
  | QuiesceRefusal
  | "INVALID_INPUT"
  | "RUN_NOT_FOUND"
  | "STEP_NOT_FOUND"
  | "STEP_NOT_FAILOVER_ELIGIBLE"
  | "ATTEMPT_NOT_FOUND"
  | "STALE_ATTEMPT"
  | "EXECUTION_MISMATCH"
  /** The result is not a usage limit: login, network, config and model errors are not failover. */
  | "NOT_A_USAGE_LIMIT"
  | "PROFILE_UNKNOWN"
  | "PROFILE_STATE_CONFLICT"
  | "STATE_REJECTED"
  /** resumeRun refused; `resume` carries its reason. The step is left `ready`, writers stopped. */
  | "RESUME_REFUSED";

export type FailoverStepResult =
  | {
      readonly ok: true;
      readonly outcome: "failed_over";
      readonly attemptId: string;
      readonly profileId: string;
      readonly resume: ResumeRunResult;
    }
  | {
      readonly ok: true;
      readonly outcome: "waiting_resource";
      readonly reason: "NO_MATCHING_COMBINATION" | "RETRY_BUDGET_EXHAUSTED";
      readonly rejections?: readonly {
        readonly candidateId: string;
        readonly reasons: readonly string[];
      }[];
    }
  | {
      readonly ok: false;
      readonly reason: FailoverRefusal;
      readonly detail?: string;
      readonly resume?: ResumeRunResult;
    };

const refuse = (reason: FailoverRefusal, detail?: string): FailoverStepResult => ({
  ok: false,
  reason,
  ...(detail === undefined ? {} : { detail }),
});

/**
 * Architecture §7 failover. On a usage limit: stop the writer, cool the profile (and so its
 * account group) down, select another profile that meets the same capability minimum, then
 * reconcile and start a NEW attempt from the latest valid checkpoint. Reconciliation and the
 * checkpoint restart are `resumeRun`'s (OMI-027); selection is `selectExecutor`'s (OMI-015).
 *
 * Quality and rework state is never read or written here: a limit is operational, so
 * `failedCycles` and the phase stay as they were. With no suitable profile the step waits in
 * `waiting_resource`. A step that must run on Codex waits for Codex rather than moving to
 * Claude (PO rule 2026-11-11); nothing here can select a paid API (profiles are subscription
 * only) or lower the effort floor, because selection applies the same capability minimum.
 */
export async function failoverStep(
  deps: FailoverStepDependencies,
  input: unknown,
): Promise<FailoverStepResult> {
  const parsed = failoverStepSchema.safeParse(input);
  if (!parsed.success) return refuse("INVALID_INPUT");
  const request = parsed.data;
  const locked = () =>
    deps.session.lease.resourceKey === PROJECT_OWNER_LEASE_KEY && deps.session.renew();
  if (!locked()) return refuse("PROJECT_LOCK_LOST");

  const run = deps.runs.get(request.runId);
  if (run === undefined) return refuse("RUN_NOT_FOUND");
  const steps = deps.runs.listSteps(run.id);
  const found = steps.find((item) => item.id === request.stepRunId);
  if (found === undefined) return refuse("STEP_NOT_FOUND");
  let step: StepRunRecord = found;
  const latest = deps.attempts.latestForStep(step.id);
  if (latest === undefined) return refuse("ATTEMPT_NOT_FOUND");

  if (step.status === "running") {
    const execution = request.execution;
    if (execution === undefined) return refuse("INVALID_INPUT", "EXECUTION_REQUIRED");
    const attempt = deps.attempts.get(execution.attemptId);
    if (attempt === undefined || attempt.stepRunId !== step.id) return refuse("ATTEMPT_NOT_FOUND");
    if (attempt.attemptNumber !== latest.attemptNumber) return refuse("STALE_ATTEMPT");
    if (attempt.executor !== execution.executor) return refuse("EXECUTION_MISMATCH");
    if (execution.outcome !== "usage-limit") return refuse("NOT_A_USAGE_LIMIT");
    const settings = deps.selections.settings(attempt.id);
    if (settings === undefined) return refuse("PROFILE_UNKNOWN");

    // 1. Stop the writer. Nothing below runs until every worker is proved stopped.
    const stopped = await quiesceRunWorkers(deps, steps, true);
    if (!stopped.ok) return refuse(stopped.reason);

    // 2. Cool the profile down, for the time the tool reported or a bounded backoff.
    const now = deps.now();
    const reportedUntil =
      execution.quota?.resetsAt === undefined ? undefined : execution.quota.resetsAt * 1000;
    const action = decideOperationalRetry({
      failure: "rate_limit",
      retriesMade: request.failoversMade,
      now,
      jitter: deps.jitter(),
      budget: deps.retryBudget,
      ...(reportedUntil === undefined ? {} : { cooldownUntil: reportedUntil }),
    });
    const cooldownUntil =
      action.action === "failover"
        ? action.cooldownUntil
        : Math.max(reportedUntil ?? 0, now + deps.retryBudget.maxDelayMs);
    const cooled = coolDown(deps, settings.chosen.profileId, cooldownUntil, now);
    if (cooled !== undefined) return cooled;

    // 3. The step waits for a resource while a profile is chosen (ADR-0031 trace).
    const waiting = transitionStep(step.status, {
      type: "wait_resource",
      attempt: attempt.attemptNumber,
      currentAttempt: latest.attemptNumber,
      previousWriterStopped: true,
    });
    if (!waiting.ok) return refuse("STATE_REJECTED", waiting.reason);
    const committed = deps.session.commit({
      target: {
        kind: "step_run",
        id: step.id,
        expectedVersion: step.version,
        toStatus: waiting.to,
      },
      event: {
        eventId: deps.nextId(),
        kind: "step.waiting_resource",
        subject: step.id,
        runId: run.id,
        correlationId: attempt.id,
        payload: JSON.stringify({
          attemptId: attempt.id,
          reason: "USAGE_LIMIT",
          profileId: settings.chosen.profileId,
          cooldownUntil,
        }),
      },
    });
    if (!committed.ok) return refuse("STATE_REJECTED", committed.reason);
    step = { ...step, status: waiting.to, version: committed.newVersion };
    if (action.action !== "failover") {
      return { ok: true, outcome: "waiting_resource", reason: "RETRY_BUDGET_EXHAUSTED" };
    }
  } else if (step.status !== "waiting_resource") {
    return refuse("STEP_NOT_FAILOVER_ELIGIBLE");
  }
  if (!locked()) return refuse("PROJECT_LOCK_LOST");

  // 4. Another profile, same capability minimum. The reservation holds its slot until dispatch.
  const stepRunId = step.id;
  const reservedAttemptId = deps.nextId();
  const attemptNumber = latest.attemptNumber + 1;
  const selection = selectExecutor(deps.selections, {
    attemptId: reservedAttemptId,
    stepRunId,
    attemptNumber,
    capabilityProfile: request.capabilityProfile,
    ...(request.requiredExecutor === undefined
      ? {}
      : { requiredExecutor: request.requiredExecutor }),
    now: deps.now(),
    models: request.models,
    task: request.task,
    effortPolicy: request.effortPolicy,
  });
  if (selection.outcome !== "selected") {
    return {
      ok: true,
      outcome: "waiting_resource",
      reason: selection.reason,
      rejections: selection.rejections,
    };
  }
  const chosen = deps.profiles
    .list()
    .find((profile) => profile.metadata.profileId === selection.candidate.profileId);
  const release = () => {
    deps.attempts.setStatus(reservedAttemptId, "cancelled");
  };
  if (chosen === undefined) {
    release();
    return refuse("PROFILE_UNKNOWN");
  }
  const available = transitionStep(step.status, {
    type: "resource_available",
    candidateAvailable: true,
  });
  if (!available.ok) {
    release();
    return refuse("STATE_REJECTED", available.reason);
  }
  const readied = deps.session.commit({
    target: {
      kind: "step_run",
      id: stepRunId,
      expectedVersion: step.version,
      toStatus: available.to,
    },
    event: {
      eventId: deps.nextId(),
      kind: "step.resource_available",
      subject: stepRunId,
      runId: run.id,
      correlationId: reservedAttemptId,
      payload: JSON.stringify({
        attemptId: reservedAttemptId,
        profileId: selection.candidate.profileId,
        executor: selection.candidate.executor,
      }),
    },
  });
  if (!readied.ok) {
    release();
    return refuse("STATE_REJECTED", readied.reason);
  }

  // 5. Reconcile and start the new attempt from the latest valid checkpoint (resumeRun).
  const chosenSelection: FailoverSelection = {
    attemptId: reservedAttemptId,
    attemptNumber,
    candidate: selection.candidate,
    effort: selection.effort,
    profileHome: chosen.metadata.credentialRef,
  };
  const resumed = await resumeRun(
    {
      ...deps,
      dispatch: (checkpoint, next) =>
        next.id === stepRunId
          ? deps.dispatch({ checkpoint, step: next, selection: chosenSelection })
          : Promise.resolve({ ok: false, reason: "UNEXPECTED_STEP" }),
    },
    { runId: run.id },
  );
  if (!resumed.ok || resumed.attemptId !== reservedAttemptId) {
    release();
    return {
      ok: false,
      reason: "RESUME_REFUSED",
      detail: resumed.ok ? "UNEXPECTED_ATTEMPT" : resumed.reason,
      resume: resumed,
    };
  }
  return {
    ok: true,
    outcome: "failed_over",
    attemptId: reservedAttemptId,
    profileId: selection.candidate.profileId,
    resume: resumed,
  };
}

/** Puts the profile in cooldown through the domain transition, with compare-and-swap. */
function coolDown(
  deps: FailoverStepDependencies,
  profileId: string,
  cooldownUntil: number,
  now: number,
): FailoverStepResult | undefined {
  const find = (): RegisteredProfile | undefined =>
    deps.profiles.list().find((profile) => profile.metadata.profileId === profileId);
  for (let tries = 0; tries < 3; tries += 1) {
    const profile = find();
    if (profile === undefined) return refuse("PROFILE_UNKNOWN");
    const metadata = profile.metadata;
    if (
      metadata.state === "cooldown" &&
      metadata.cooldownUntil !== undefined &&
      metadata.cooldownUntil >= cooldownUntil
    ) {
      return undefined;
    }
    // A longer reported reset replaces a shorter cooldown; login-required, disabled and
    // unavailable keep their own meaning and are not turned into a quota cooldown.
    const from = metadata.state === "cooldown" ? "ready" : metadata.state;
    const next = transitionProfile(from, { type: "limit_hit", now, cooldownUntil });
    if (!next.ok) return undefined;
    if (deps.profiles.save({ ...metadata, state: next.to, cooldownUntil }, now, profile.revision)) {
      return undefined;
    }
  }
  return refuse("PROFILE_STATE_CONFLICT");
}
