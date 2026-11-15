import type { RecoveryRun } from "./run-recovery.js";

/** Runs that are not finished (not succeeded or cancelled), oldest first. */
export interface ActiveRunReader {
  listActive(): readonly RecoveryRun[];
}
