import type { ArchivedLog, WorkerLog } from "../../domain/runs/log-retention-policy.js";

/**
 * The runtime's directory of worker logs and its `archive/` subdirectory. Files that do not
 * follow the log naming are neither listed nor touched. Names are plain file names (root) or
 * `archive/<name>`; anything else throws `INVALID_PATH`. A file that vanished is not an error,
 * so a re-run or a race never fails on it.
 */
export interface WorkerLogStore {
  list(): Promise<{
    readonly root: readonly WorkerLog[];
    readonly archive: readonly ArchivedLog[];
  }>;
  /** Gzips the root file into `archive/<name>.gz` (keeping its mtime), then removes it. */
  archive(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}
