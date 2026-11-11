import { transitionAgentAttempt } from "../../domain/runs/agent-attempt.js";
import type { AttemptStore, StepRunRecord } from "../ports/attempt-store.js";
import type { GitWorkspace } from "../ports/git-workspace.js";
import type { ProjectSession } from "../ports/lease-store.js";
import type { WorkerRecovery } from "../ports/run-recovery.js";

export type QuiesceRefusal =
  | "ATTEMPT_STATE_REJECTED"
  | "PROJECT_LOCK_LOST"
  | "WORKER_STILL_RUNNING"
  | "WORKER_NOT_OWNED"
  | "WORKER_IDENTITY_UNKNOWN"
  | "WRITER_RELEASE_REJECTED";

/** No reservation is released until every relevant worker is proved stopped. */
export async function quiesceRunWorkers(
  deps: {
    session: ProjectSession;
    attempts: AttemptStore;
    workspaces: GitWorkspace;
    processes: WorkerRecovery;
    now(): number;
  },
  steps: readonly StepRunRecord[],
  stopOwned: boolean,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: QuiesceRefusal }> {
  if (
    steps.some(
      (step) => step.status === "running" && deps.attempts.latestForStep(step.id) === undefined,
    )
  ) {
    return { ok: false, reason: "WORKER_IDENTITY_UNKNOWN" };
  }
  const attempts = steps.flatMap((step) => {
    const attempt = deps.attempts.latestForStep(step.id);
    return attempt === undefined ? [] : [attempt];
  });
  for (const attempt of attempts) {
    let state = deps.processes.inspect(attempt);
    if (state === "owned-running" && stopOwned) {
      await deps.processes.stopOwned(attempt);
      if (!deps.session.renew()) return { ok: false, reason: "PROJECT_LOCK_LOST" };
      state = deps.processes.inspect(attempt);
    }
    if (state !== "stopped") {
      return {
        ok: false,
        reason:
          state === "unknown"
            ? "WORKER_IDENTITY_UNKNOWN"
            : state === "unowned-running"
              ? "WORKER_NOT_OWNED"
              : "WORKER_STILL_RUNNING",
      };
    }
  }
  if (!deps.session.renew()) return { ok: false, reason: "PROJECT_LOCK_LOST" };
  for (const attempt of attempts) {
    // Terminal attempts have already released their reservation in recordStepResult. Only an
    // unfinished attempt owns an unreleased reservation; stale releases are never ignored.
    if (
      attempt.status !== "running" &&
      attempt.status !== "pending" &&
      attempt.status !== "interrupted"
    )
      continue;
    const transition =
      attempt.status === "interrupted"
        ? undefined
        : transitionAgentAttempt(attempt.status, {
            type: attempt.status === "running" ? "interrupt" : "cancel",
            generation: attempt.workspace.generation,
            currentGeneration: attempt.workspace.generation,
            writerStopped: true,
            resultValid: false,
          });
    if (transition !== undefined && !transition.ok)
      return { ok: false, reason: "ATTEMPT_STATE_REJECTED" };
    const released = deps.workspaces.releaseWriter({
      taskId: attempt.workspace.taskId,
      slug: attempt.workspace.slug,
      owner: attempt.workspace.owner,
      generation: attempt.workspace.generation,
      now: new Date(deps.now()).toISOString(),
    });
    if (!released.ok) return { ok: false, reason: "WRITER_RELEASE_REJECTED" };
    if (transition?.ok === true) deps.attempts.setStatus(attempt.id, transition.to);
  }
  return { ok: true };
}
