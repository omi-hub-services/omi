import type { ActiveRunReader } from "../../ports/active-run-reader.js";
import type { ExecutorSelectionStore } from "../../ports/executor-selection-store.js";
import type { RuntimeStatus } from "../../contracts/runtime-status.js";
import { CONTRACT_SCHEMA_VERSION } from "../../contracts/schema-version.js";

/** Facts fixed when the runtime starts; bootstrap supplies them (no hidden clock or file read). */
export interface RuntimeIdentity {
  readonly runtimeVersion: string;
  /** ISO-8601 UTC start time. */
  readonly startedAt: string;
}

/**
 * Answers the Coordinator's `status` command for the runtime itself: version, start time, the
 * chosen executor settings of attempts, and the runs that are not finished (so a new session can
 * find what to resume). A single run's steps are `inspectRun`.
 */
export function inspectRuntime(
  identity: RuntimeIdentity,
  selections?: Pick<ExecutorSelectionStore, "listSettings">,
  runs?: ActiveRunReader,
): RuntimeStatus {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    state: "ready",
    runtimeVersion: identity.runtimeVersion,
    startedAt: identity.startedAt,
    ...(selections === undefined ? {} : { attempts: [...selections.listSettings()] }),
    ...(runs === undefined
      ? {}
      : { runs: runs.listActive().map((run) => ({ runId: run.id, status: run.status })) }),
  };
}
