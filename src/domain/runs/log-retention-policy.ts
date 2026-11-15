/**
 * Retention of worker logs (OMI-080, ADR-0014 rule 056). Pure: a listing goes in, keep/archive/
 * delete decisions come out. The newest stream log of each profile is never moved, because quota
 * reading looks at it.
 */
export interface WorkerLog {
  readonly name: string;
  readonly taskId: string;
  /** Profile of a stream log (`.jsonl`); null for every other file of the task. */
  readonly profile: string | null;
  readonly size: number;
  /** Modification time, epoch milliseconds. */
  readonly mtimeMs: number;
  /** A worker process still writes it. */
  readonly running: boolean;
}

export interface ArchivedLog {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface LogRetentionSettings {
  readonly recentMinutes: number;
  readonly archiveMaxBytes: number;
  readonly archiveMaxAgeDays: number;
}

export interface LogListing {
  readonly now: number;
  readonly root: readonly WorkerLog[];
  readonly archive: readonly ArchivedLog[];
}

export interface LogDecision {
  /** Root file name, or `archive/<name>` for an archive entry. */
  readonly name: string;
  readonly action: "keep" | "archive" | "delete";
  readonly reason: string;
}

/** Newest wins; the name breaks a tie so the choice is stable. */
const newer = (a: WorkerLog, b: WorkerLog): boolean =>
  a.mtimeMs > b.mtimeMs || (a.mtimeMs === b.mtimeMs && a.name > b.name);

/**
 * `doneTasks`: tasks whose files may be archived. Files of other tasks are left alone, but still
 * count when choosing the newest log of a profile.
 */
export function planLogRetention(
  listing: LogListing,
  doneTasks: ReadonlySet<string>,
  settings: LogRetentionSettings,
): LogDecision[] {
  const newest = new Map<string, WorkerLog>();
  for (const file of listing.root) {
    if (file.profile === null) continue;
    const best = newest.get(file.profile);
    if (best === undefined || newer(file, best)) newest.set(file.profile, file);
  }
  const keepNewest = new Set([...newest.values()].map((file) => file.name));
  const recent = listing.now - settings.recentMinutes * 60_000;

  const decisions: LogDecision[] = [];
  for (const file of [...listing.root].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!doneTasks.has(file.taskId)) continue;
    const decide = (action: LogDecision["action"], reason: string): void => {
      decisions.push({ name: file.name, action, reason });
    };
    if (file.running) decide("keep", "a running worker writes it");
    else if (file.mtimeMs > recent)
      decide("keep", `written in the last ${String(settings.recentMinutes)} min`);
    else if (keepNewest.has(file.name)) decide("keep", "newest log of its profile");
    else decide("archive", "log of a Done task");
  }

  // The cap sees the archive as listed: files archived by this very run count next time.
  const cutoff = listing.now - settings.archiveMaxAgeDays * 86_400_000;
  const stored = [...listing.archive].sort(
    (a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name),
  );
  const drop = (file: ArchivedLog, reason: string): void => {
    decisions.push({ name: `archive/${file.name}`, action: "delete", reason });
  };
  const young = stored.filter((file) => file.mtimeMs >= cutoff);
  for (const file of stored.filter((entry) => entry.mtimeMs < cutoff)) {
    drop(file, `older than ${String(settings.archiveMaxAgeDays)} days`);
  }
  let total = young.reduce((sum, file) => sum + file.size, 0);
  for (const file of young) {
    if (total <= settings.archiveMaxBytes) break;
    total -= file.size;
    drop(file, `archive over ${String(settings.archiveMaxBytes)} bytes`);
  }
  return decisions;
}
