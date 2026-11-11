import { z } from "zod";
import { transitionRun } from "../../../domain/runs/workflow-run.js";
import { transitionStep } from "../../../domain/runs/step-run.js";
import { checkpointManifestSchema, type CheckpointManifest } from "../../contracts/checkpoint.js";
import { identifierSchema } from "../../contracts/identifiers.js";
import type { AttemptStore } from "../../ports/attempt-store.js";
import { ArtifactError, type ArtifactStore } from "../../ports/artifact-store.js";
import type { CheckpointProblem, CheckpointStore } from "../../ports/checkpoint-store.js";
import type { GitWorkspace } from "../../ports/git-workspace.js";
import type { ProjectSession } from "../../ports/lease-store.js";
import type {
  RecoveryDispatch,
  RecoveryGate,
  RecoveryRunReader,
  WorkerRecovery,
} from "../../ports/run-recovery.js";
import { PROJECT_OWNER_LEASE_KEY } from "../../services/claim-project-session.js";
import { quiesceRunWorkers, type QuiesceRefusal } from "../../services/quiesce-run-workers.js";
import {
  reconcileGithub,
  type ReconcileGithubDeps,
  type ReconcileReport,
} from "../sync/reconcile-github.js";

export interface ResumeRunDependencies {
  /** Already claimed by claimProjectSession, shared with the runtime and retained on return. */
  readonly session: ProjectSession;
  readonly runs: RecoveryRunReader;
  readonly attempts: AttemptStore;
  readonly processes: WorkerRecovery;
  readonly checkpoints: CheckpointStore;
  readonly artifacts: ArtifactStore;
  readonly workspaces: GitWorkspace;
  readonly github: ReconcileGithubDeps;
  readonly validateGates: RecoveryGate;
  readonly dispatch: RecoveryDispatch;
  readonly now: () => number;
  readonly nextId: () => string;
}
export type ResumeRefusal =
  | QuiesceRefusal
  | "INVALID_INPUT"
  | "RUN_NOT_FOUND"
  | "RUN_NOT_RESUMABLE"
  | "CHECKPOINT_MISSING"
  | "CHECKPOINT_INVALID"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_HASH_MISMATCH"
  | "ARTIFACT_INVALID"
  | "WORKSPACE_UNAVAILABLE"
  | "GIT_MISMATCH"
  | "UNCOMMITTED_UNVERIFIABLE"
  | "UNCOMMITTED_MISMATCH"
  | "GITHUB_UNRESOLVED"
  | "GATE_INVALID"
  | "STATE_REJECTED"
  | "NO_READY_STEP"
  | "DISPATCH_FAILED";
export type ResumeRunResult = (
  | {
      readonly ok: true;
      readonly checkpoint: CheckpointManifest;
      readonly attemptId?: string;
      readonly stepRunId?: string;
    }
  | { readonly ok: false; readonly reason: ResumeRefusal; readonly detail?: string }
) & {
  readonly checkpointProblems?: readonly CheckpointProblem[];
  readonly github?: ReconcileReport;
};

/** Architecture §10. No dispatch occurs until process, files, remote actions and current gates
 * have been reconciled under the session's project lock. Never executes nextAction as code.
 */
export async function resumeRun(
  deps: ResumeRunDependencies,
  input: unknown,
): Promise<ResumeRunResult> {
  const parsed = z.strictObject({ runId: identifierSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const locked = () =>
    deps.session.lease.resourceKey === PROJECT_OWNER_LEASE_KEY && deps.session.renew();
  if (!locked()) return { ok: false, reason: "PROJECT_LOCK_LOST" };
  const run = deps.runs.get(parsed.data.runId);
  if (run === undefined) return { ok: false, reason: "RUN_NOT_FOUND" };
  // Running is accepted for a retry after recovery committed state but dispatch did not happen.
  if (!["paused", "interrupted", "running"].includes(run.status))
    return { ok: false, reason: "RUN_NOT_RESUMABLE" };
  const steps = deps.runs.listSteps(run.id);
  const stopped = await quiesceRunWorkers(deps, steps, false);
  if (!stopped.ok) return stopped;
  const at = new Date(deps.now()).toISOString();
  const reconciliation = deps.checkpoints.reconcile(run.id, at);
  const checkpointProblems = [...reconciliation.problems];
  const selected = deps.checkpoints.latestValid(run.id, at, (problem) => {
    checkpointProblems.push(problem);
  });
  if (selected === undefined)
    return { ok: false, reason: "CHECKPOINT_MISSING", checkpointProblems };
  let checkpoint: CheckpointManifest;
  try {
    checkpoint = checkpointManifestSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(selected.bytes)),
    );
  } catch {
    return { ok: false, reason: "CHECKPOINT_INVALID", checkpointProblems };
  }
  if (
    checkpoint.runId !== run.id ||
    checkpoint.checkpointId !== selected.record.id ||
    checkpoint.kind !== selected.record.kind ||
    checkpoint.stepRunId !== selected.record.stepRunId ||
    (selected.record.gitRevision !== undefined &&
      checkpoint.git.headSha !== selected.record.gitRevision)
  ) {
    return { ok: false, reason: "CHECKPOINT_INVALID", checkpointProblems };
  }
  if (checkpoint.stepRunId !== undefined) {
    const step = steps.find((item) => item.id === checkpoint.stepRunId);
    if (
      step === undefined ||
      (checkpoint.stepId !== undefined && checkpoint.stepId !== step.stepId)
    ) {
      return { ok: false, reason: "CHECKPOINT_INVALID", checkpointProblems };
    }
  }
  if (checkpoint.attemptId !== undefined) {
    const attempt = deps.attempts.get(checkpoint.attemptId);
    if (
      attempt === undefined ||
      attempt.runId !== run.id ||
      attempt.stepRunId !== checkpoint.stepRunId ||
      attempt.stepId !== checkpoint.stepId ||
      attempt.attemptNumber !== checkpoint.attemptNumber ||
      attempt.workspace.path !== checkpoint.git.worktreePath
    ) {
      return { ok: false, reason: "CHECKPOINT_INVALID", checkpointProblems };
    }
  }
  const git = deps.workspaces.inspect(checkpoint.git.worktreePath);
  if (!git.ok)
    return {
      ok: false,
      reason: "WORKSPACE_UNAVAILABLE",
      detail: git.error.code,
      checkpointProblems,
    };
  if (
    git.value.path !== checkpoint.git.worktreePath ||
    git.value.headSha !== checkpoint.git.headSha ||
    git.value.branch !== checkpoint.git.branch ||
    git.value.dirty !== checkpoint.git.dirty
  ) {
    return { ok: false, reason: "GIT_MISMATCH", checkpointProblems };
  }
  const uncommitted = deps.workspaces.listUncommitted(checkpoint.git.worktreePath);
  if (!uncommitted.ok)
    return {
      ok: false,
      reason: "WORKSPACE_UNAVAILABLE",
      detail: uncommitted.error.code,
      checkpointProblems,
    };
  for (const manifest of [checkpoint.uncommitted, uncommitted.value]) {
    if (
      manifest.truncated ||
      manifest.excludedCredentialPaths > 0 ||
      manifest.entries.some((entry) => entry.sha256 === null && entry.status !== "deleted")
    ) {
      return { ok: false, reason: "UNCOMMITTED_UNVERIFIABLE", checkpointProblems };
    }
  }
  const canonical = (manifest: typeof checkpoint.uncommitted) =>
    JSON.stringify(
      [...manifest.entries]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((entry) => [entry.path, entry.status, entry.staged, entry.sha256, entry.size]),
    );
  if (canonical(checkpoint.uncommitted) !== canonical(uncommitted.value))
    return { ok: false, reason: "UNCOMMITTED_MISMATCH", checkpointProblems };
  try {
    const verified = deps.artifacts.manifest(
      checkpoint.outputs.map(({ path, sha256 }) => ({ path, sha256 })),
    );
    if (
      verified.artifacts.some(
        (artifact, index) => artifact.size !== checkpoint.outputs[index]?.size,
      )
    ) {
      return { ok: false, reason: "ARTIFACT_HASH_MISMATCH", checkpointProblems };
    }
  } catch (error) {
    if (!(error instanceof ArtifactError)) throw error;
    return {
      ok: false,
      reason:
        error.code === "NOT_FOUND"
          ? "ARTIFACT_MISSING"
          : error.code === "HASH_MISMATCH"
            ? "ARTIFACT_HASH_MISMATCH"
            : "ARTIFACT_INVALID",
      checkpointProblems,
    };
  }
  if (!locked()) return { ok: false, reason: "PROJECT_LOCK_LOST", checkpointProblems };
  // Existing outbox machinery is the sole authority for PR/merge replay decisions.
  const github = await reconcileGithub({
    ...deps.github,
    outbox: {
      get: (key) => deps.github.outbox.get(key),
      listDue: (at, limit) => deps.github.outbox.listDue(at, limit),
      listUnresolved: () => deps.github.outbox.listUnresolved(),
      transition: (change) =>
        deps.github.outbox.transition({
          ...change,
          fence: {
            resourceKey: deps.session.lease.resourceKey,
            owner: deps.session.lease.owner,
            generation: deps.session.lease.generation,
          },
        }),
    },
  });
  if (!locked()) return { ok: false, reason: "PROJECT_LOCK_LOST", checkpointProblems, github };
  if (
    github.githubUnavailable ||
    github.entries.some((entry) => !["pending", "succeeded"].includes(entry.outcome))
  ) {
    return { ok: false, reason: "GITHUB_UNRESOLVED", checkpointProblems, github };
  }
  const gates = await deps.validateGates(checkpoint, deps.runs.listSteps(run.id));
  if (!locked()) return { ok: false, reason: "PROJECT_LOCK_LOST", checkpointProblems, github };
  if (!gates.ok)
    return { ok: false, reason: "GATE_INVALID", detail: gates.reason, checkpointProblems, github };
  // Only unfinished, recoverable steps change. Accepted results are authoritative even when the
  // latest checkpoint predates recordStepResult's commit (crash at its after-output boundary).
  for (const step of deps.runs.listSteps(run.id)) {
    const events =
      step.status === "running"
        ? [
            {
              type: "interrupt",
              attempt: deps.attempts.latestForStep(step.id)?.attemptNumber ?? 0,
              currentAttempt: deps.attempts.latestForStep(step.id)?.attemptNumber ?? 0,
            } as const,
            {
              type: "reconciled",
              reconciliationDone: true,
              oldProcessGone: true,
              checkpointValid: true,
            } as const,
          ]
        : step.status === "interrupted"
          ? [
              {
                type: "reconciled",
                reconciliationDone: true,
                oldProcessGone: true,
                checkpointValid: true,
              } as const,
            ]
          : step.status === "paused"
            ? [{ type: "resume", checkpointValid: true } as const]
            : [];
    let status = step.status;
    let version = step.version;
    for (const event of events) {
      const transition = transitionStep(status, event);
      if (!transition.ok)
        return {
          ok: false,
          reason: "STATE_REJECTED",
          detail: transition.reason,
          checkpointProblems,
          github,
        };
      const result = deps.session.commit({
        target: {
          kind: "step_run",
          id: step.id,
          expectedVersion: version,
          toStatus: transition.to,
        },
        event: {
          eventId: deps.nextId(),
          kind: `step.${event.type}`,
          subject: step.id,
          runId: run.id,
          correlationId: checkpoint.checkpointId,
          payload: "{}",
        },
      });
      if (!result.ok)
        return {
          ok: false,
          reason: "STATE_REJECTED",
          detail: result.reason,
          checkpointProblems,
          github,
        };
      status = transition.to;
      version = result.newVersion;
    }
  }
  const current = deps.runs.get(run.id);
  if (current === undefined)
    return { ok: false, reason: "RUN_NOT_FOUND", checkpointProblems, github };
  if (current.status !== "running") {
    const transition = transitionRun(
      current.status,
      current.status === "paused"
        ? { type: "resume", checkpointValid: true }
        : {
            type: "reconciled",
            reconciliationDone: true,
            oldProcessGone: true,
            checkpointValid: true,
          },
    );
    if (!transition.ok)
      return {
        ok: false,
        reason: "STATE_REJECTED",
        detail: transition.reason,
        checkpointProblems,
        github,
      };
    const result = deps.session.commit({
      target: {
        kind: "workflow_run",
        id: run.id,
        expectedVersion: current.version,
        toStatus: transition.to,
      },
      event: {
        eventId: deps.nextId(),
        kind: "run.resumed",
        subject: run.id,
        runId: run.id,
        correlationId: checkpoint.checkpointId,
        payload: JSON.stringify({ checkpointId: checkpoint.checkpointId, checkpointProblems }),
      },
    });
    if (!result.ok)
      return {
        ok: false,
        reason: "STATE_REJECTED",
        detail: result.reason,
        checkpointProblems,
        github,
      };
  }
  const remaining = deps.runs.listSteps(run.id).filter((step) => step.status !== "succeeded");
  if (remaining.length === 0) return { ok: true, checkpoint, checkpointProblems, github };
  const next = remaining.find((step) => step.status === "ready");
  if (next === undefined) return { ok: false, reason: "NO_READY_STEP", checkpointProblems, github };
  if (!locked()) return { ok: false, reason: "PROJECT_LOCK_LOST", checkpointProblems, github };
  const dispatched = await deps.dispatch(checkpoint, next);
  if (!locked()) return { ok: false, reason: "PROJECT_LOCK_LOST", checkpointProblems, github };
  if (!dispatched.ok)
    return {
      ok: false,
      reason: "DISPATCH_FAILED",
      detail: dispatched.reason,
      checkpointProblems,
      github,
    };
  return {
    ok: true,
    checkpoint,
    stepRunId: next.id,
    attemptId: dispatched.attemptId,
    checkpointProblems,
    github,
  };
}
