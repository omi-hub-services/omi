import { stepResultSchema } from "../contracts/result.js";
import { extractStepResult } from "../contracts/step-result-extract.js";
import { redactDiagnostic } from "../../domain/shared/redact-diagnostic.js";
import { contextPacketSchema } from "../contracts/context.js";
import type { ExecutionHandle } from "../contracts/agent-execution.js";
import type { CheckRunRecord } from "../contracts/check-run.js";
import type { Finding } from "../contracts/result.js";
import type { StepFindingStore } from "../ports/step-findings.js";
import type { CheckRunner } from "../ports/check-runner.js";
import type { DispatchStepDependencies } from "../use-cases/runs/dispatch-step.js";
import type { AdvanceRunDependencies } from "../use-cases/runs/advance-run.js";
import { advanceRun } from "../use-cases/runs/advance-run.js";
import { recordStepResult } from "../use-cases/runs/record-step-result.js";
import {
  failoverStep,
  type FailoverStepDependencies,
} from "../use-cases/profiles/failover-step.js";
import {
  recordReworkEvent,
  type RecordReworkEventDependencies,
} from "../use-cases/runs/record-rework-event.js";
import type { ExecutorSelectionStore } from "../ports/executor-selection-store.js";
import { transitionStep } from "../../domain/runs/step-run.js";

export interface CompletionRouting {
  readonly failover?: FailoverStepDependencies;
  readonly rework?: RecordReworkEventDependencies;
  /** Runs the required checks the project configured; their ids never pass on a worker's word. */
  readonly checks?: CheckRunner;
  /** Receives a failed check's summary for the step's next attempt. */
  readonly findings?: Pick<StepFindingStore, "remember">;
  readonly selections?: ExecutorSelectionStore;
  readonly failoversMade?: (stepRunId: string) => number;
}

/** A limit is operational and must reach failover BEFORE generic result recording fails a step. */
export async function completeRunAttempt(
  deps: DispatchStepDependencies & AdvanceRunDependencies & CompletionRouting,
  attemptId: string,
  handle: ExecutionHandle,
  runId: string,
  request: Readonly<Record<string, unknown>>,
): Promise<void> {
  try {
    const execution = await deps.executor.collectResult(handle);
    deps.selections?.recordResult(attemptId, execution);
    // Pause/owner shutdown reconciles the stopped writer through quiesceRunWorkers. A cancelled
    // process is not a quality failure and must remain recoverable from its boundary checkpoint.
    if (execution.outcome === "cancelled") return;
    const attempt = deps.attempts.get(attemptId);
    if (attempt === undefined) throw new Error("ATTEMPT_NOT_FOUND");
    if (execution.outcome === "usage-limit" && deps.failover !== undefined) {
      const plan = deps.plans.forRun(runId);
      const step =
        plan === undefined
          ? undefined
          : deps.workflows
              .byHash(plan.templateHash)
              ?.workflow.steps.find((entry) => entry.id === attempt.stepId);
      if (step === undefined) throw new Error("WORKFLOW_UNKNOWN");
      const result = await failoverStep(deps.failover, {
        ...(request["quality"] === undefined ? {} : { quality: request["quality"] }),
        runId,
        stepRunId: attempt.stepRunId,
        capabilityProfile: step.capability_profile,
        models: request["models"],
        task: request["task"],
        effortPolicy: request["effortPolicy"],
        execution,
        failoversMade: deps.failoversMade?.(attempt.stepRunId) ?? 0,
      });
      if (!result.ok) throw new Error(result.reason);
      return;
    }
    const extracted =
      execution.finalMessage === undefined ? undefined : extractStepResult(execution.finalMessage);
    const report = extracted?.ok === true ? extracted.value : undefined;
    const reported = stepResultSchema.safeParse(report);
    if (execution.outcome === "succeeded" && !reported.success) {
      keepFinalMessage(deps, attempt, execution.finalMessage);
    }
    const checkRuns = await runRequiredChecks(deps, attempt, execution.outcome, reported);
    const recorded = recordStepResult(deps, { attemptId, execution, result: report, checkRuns });
    if (!recorded.ok) return;
    deps.findings?.remember(
      attempt.stepRunId,
      recorded.failure === "CHECK_FAILED" || recorded.failure === "CHECK_TIMED_OUT"
        ? checkFindings(deps, checkRuns)
        : recorded.failure === "SKILL_EVIDENCE_MISSING"
          ? skillFindings(attempt, reported.success ? reported.data : undefined)
          : [],
    );
    if (
      !(reported.success && reported.data.status === "blocked") &&
      recorded.stepStatus === "failed" &&
      execution.outcome === "succeeded" &&
      deps.rework !== undefined
    ) {
      const result = await recordReworkEvent(deps.rework, {
        runId,
        event: { type: "cycle_failed", cycleId: attempt.id, kind: "quality" },
      });
      if (!result.ok) throw new Error(result.reason);
      if (result.action === "retry") {
        const step = deps.steps.get(attempt.stepRunId);
        if (step === undefined) throw new Error("STEP_NOT_FOUND");
        const retry = transitionStep(step.status, {
          type: "retry_authorized",
          reworkAllowsRetry: true,
        });
        if (!retry.ok) throw new Error(retry.reason);
        deps.session.commit({
          target: {
            kind: "step_run",
            id: step.id,
            expectedVersion: step.version,
            toStatus: retry.to,
          },
          event: {
            eventId: deps.nextId(),
            kind: "step.retry_authorized",
            subject: step.id,
            runId,
            correlationId: attempt.id,
            payload: "{}",
          },
        });
      }
    }
    advanceRun(deps, { runId });
  } catch {
    // Keep durable state for recovery; never convert a completion exception into success.
    try {
      deps.session.commit({
        target: { kind: "session_event" },
        event: {
          eventId: deps.nextId(),
          kind: "attempt.completion_refused",
          subject: attemptId,
          runId,
          correlationId: attemptId,
          payload: "{}",
        },
      });
    } catch {
      /* A lost session cannot append audit; recovery retains its durable state. */
    }
  }
}

const MAX_CHECK_LOG_CHARS = 1200;

/** One bounded finding per check that did not pass; the full log stays in the evidence artifact. */
function checkFindings(deps: DispatchStepDependencies, runs: readonly CheckRunRecord[]): Finding[] {
  return runs
    .filter((run) => run.status !== "passed")
    .map((run) => {
      let tail = "";
      try {
        const stored = JSON.parse(new TextDecoder().decode(deps.artifacts.read(run.evidence))) as {
          log?: unknown;
        };
        if (typeof stored.log === "string") tail = stored.log.slice(-MAX_CHECK_LOG_CHARS);
      } catch {
        /* The path below still tells the worker where the evidence is. */
      }
      const outcome =
        run.status === "timed-out"
          ? "timed out"
          : `failed (exit code ${run.exitCode === null ? "none" : String(run.exitCode)})`;
      return {
        id: `check-${run.checkId}`.slice(0, 100),
        severity: "major" as const,
        message:
          `Runtime check ${run.checkId} ${outcome}. Fix the cause. Last output:\n${tail}`.slice(
            0,
            2000,
          ),
        location: run.evidence.path,
      };
    });
}

/** Names the skills the report left out so the next attempt reports each with its own note. */
function skillFindings(
  attempt: NonNullable<ReturnType<DispatchStepDependencies["attempts"]["get"]>>,
  report: { readonly skillsApplied: readonly { readonly id: string }[] } | undefined,
): Finding[] {
  const reported = new Set(report?.skillsApplied.map((skill) => skill.id));
  const missing = attempt.skills.map((skill) => skill.id).filter((id) => !reported.has(id));
  if (missing.length === 0) return [];
  return [
    {
      id: "skill-evidence-missing",
      severity: "major" as const,
      message: (
        `Skills missing from skillsApplied: ${missing.join(", ")}. Report every skill in skillsManifest, ` +
        `each with its own non-empty note in the artifact directory (one line why, if it did not apply).`
      ).slice(0, 2000),
      location: attempt.artifactRoot,
    },
  ];
}

const MAX_FINAL_MESSAGE_CHARS = 8000;

/**
 * RESULT_MISSING / RESULT_INVALID leave nothing to diagnose from, so keep the tail of the final
 * message (where the document or the worker's excuse is) with the attempt's artifacts. Redacted
 * and bounded; it is for people, never for a prompt. A failed write must not hide the outcome.
 */
function keepFinalMessage(
  deps: DispatchStepDependencies,
  attempt: NonNullable<ReturnType<DispatchStepDependencies["attempts"]["get"]>>,
  finalMessage: string | undefined,
): void {
  if (finalMessage === undefined || finalMessage.trim() === "") return;
  const text = redactDiagnostic(finalMessage, finalMessage.length).slice(-MAX_FINAL_MESSAGE_CHARS);
  try {
    deps.artifacts.write({
      id: deps.nextId(),
      path: `${attempt.artifactRoot}/final-message.txt`,
      bytes: new TextEncoder().encode(text),
      producerAttemptId: attempt.id,
      classification: "final-message",
      createdAt: new Date(deps.now()).toISOString(),
    });
  } catch {
    /* Diagnosis is best effort; the step outcome is recorded either way. */
  }
}

/**
 * Runs, in the attempt's worktree, every required check the runtime owns (OMI-085). Only a
 * result that could still be accepted is worth a run: the process succeeded, the worker claims
 * success and its revision is the worktree's head, so the check runs on exactly that revision.
 */
async function runRequiredChecks(
  deps: DispatchStepDependencies & CompletionRouting,
  attempt: NonNullable<ReturnType<DispatchStepDependencies["attempts"]["get"]>>,
  outcome: string,
  reported: ReturnType<typeof stepResultSchema.safeParse>,
): Promise<CheckRunRecord[]> {
  const runner = deps.checks;
  if (runner === undefined || attempt.status !== "running" || outcome !== "succeeded") return [];
  const packet = contextPacketSchema.parse(
    JSON.parse(new TextDecoder().decode(deps.artifacts.read(attempt.contextPacket))) as unknown,
  );
  if (packet.quality?.step === "verify" || packet.quality?.step === "review")
    return packet.checkEvidence ?? [];
  if (!reported.success || reported.data.status !== "succeeded") return [];
  const ids = attempt.requiredChecks.filter((id) => runner.has(id));
  if (ids.length === 0) return [];
  // The check runs on the runtime's own head; recording refuses a worker claim that disagrees.
  const state = deps.workspaces.inspect(attempt.workspace.path);
  if (!state.ok) return [];
  const claimed = reported.data.revision?.headSha;
  if (claimed !== undefined && /^[0-9a-f]{40}$/.test(claimed) && claimed !== state.value.headSha) {
    return [];
  }
  const runs: CheckRunRecord[] = [];
  for (const checkId of ids) {
    runs.push(
      await runner.run({
        attemptId: attempt.id,
        checkId,
        workspacePath: attempt.workspace.path,
        artifactRoot: attempt.artifactRoot,
      }),
    );
  }
  return runs;
}
