import { z } from "zod";
import { slugSchema } from "../../contracts/identifiers.js";
import type { ActiveRunReader } from "../../ports/active-run-reader.js";
import type { ProjectSession } from "../../ports/lease-store.js";
import type { PauseRunResult } from "./pause-run.js";

const handoffSchema = z.strictObject({
  reason: z.enum(["new-session", "profile-switch"]),
  /** Label of the Windows Coordinator profile the PO will use next; never a credential. */
  toProfile: slugSchema.optional(),
});

export interface HandoffCoordinatorDependencies {
  readonly runs: ActiveRunReader;
  readonly pause: (runId: string) => Promise<PauseRunResult>;
  readonly session: Pick<ProjectSession, "record">;
}

export type HandoffCoordinatorResult =
  | {
      readonly ok: true;
      /** Runs stopped and checkpointed now. */
      readonly paused: readonly { readonly runId: string; readonly checkpointId: string }[];
      /** Runs that were already stopped (paused, interrupted or blocked). */
      readonly alreadyStopped: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: "INVALID_INPUT" | "PROFILE_REQUIRED" | "PAUSE_FAILED";
      readonly detail?: string;
    };

const STOPPED = new Set(["paused", "interrupted", "blocked"]);

/**
 * Ends a Coordinator session cleanly (a new session, or a manual switch of the Windows
 * Coordinator profile, ADR-0012 §4): every running run is paused at a checkpoint with its workers
 * stopped, and the handoff is recorded. The runtime never changes a Coordinator login; the PO
 * opens the next session and asks for `resume`. Stops at the first run that cannot be paused, so
 * the PO is never told the handoff is safe while a writer may still be running.
 */
export async function handoffCoordinator(
  deps: HandoffCoordinatorDependencies,
  input: unknown,
): Promise<HandoffCoordinatorResult> {
  const parsed = handoffSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  if (parsed.data.reason === "profile-switch" && parsed.data.toProfile === undefined)
    return { ok: false, reason: "PROFILE_REQUIRED" };

  const paused: { runId: string; checkpointId: string }[] = [];
  const alreadyStopped: string[] = [];
  for (const run of deps.runs.listActive()) {
    if (STOPPED.has(run.status)) {
      alreadyStopped.push(run.id);
      continue;
    }
    const result = await deps.pause(run.id);
    if (!result.ok) {
      return {
        ok: false,
        reason: "PAUSE_FAILED",
        detail: `${run.id}: ${result.reason}`,
      };
    }
    paused.push({ runId: run.id, checkpointId: result.checkpointId });
  }
  deps.session.record("coordinator.handoff", {
    reason: parsed.data.reason,
    ...(parsed.data.toProfile === undefined ? {} : { toProfile: parsed.data.toProfile }),
    paused,
    alreadyStopped,
  });
  return { ok: true, paused, alreadyStopped };
}
