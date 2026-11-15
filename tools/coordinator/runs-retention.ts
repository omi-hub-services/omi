// Retention of worker logs in ~/omi-runs (OMI-056, ADR-0014). Pure: a listing goes in, per-file
// keep/archive/delete decisions come out; flow.ts does the I/O. What wsl-workers.ts (newest
// `*.jsonl`) and quota.ts (newest `omi-*.jsonl` per profile) read at the root is never moved.
import { RUNS_DIR_FROM_HOME, type RunsRetention } from "./coordinator-settings.ts";

export interface RunFile {
  readonly name: string;
  readonly size: number;
  /** Modification time, epoch seconds. */
  readonly mtime: number;
  /** A process still holds the file open (a running worker). */
  readonly live: boolean;
}

export interface RunsListing {
  readonly now: number;
  /** `omi-*` files at the root of ~/omi-runs. */
  readonly root: readonly RunFile[];
  /** Files of `~/omi-runs/archive/`, named without the directory. */
  readonly archive: readonly RunFile[];
}

export interface RetentionDecision {
  /** Root file name, or `archive/<name>` for an archive entry. */
  readonly name: string;
  readonly action: "keep" | "archive" | "delete";
  readonly reason: string;
}

/** Task number (`052`) of an `omi-NNN-...` file, or null. */
export const logTask = (name: string): string | null => /^omi-(\d+)-/.exec(name)?.[1] ?? null;

// `omi-NNN-<profile>-<ts>[-<packet>].jsonl` as quota.ts reads it; no profile part means a legacy log.
const JSONL = /^omi-\d+-(?:(.+)-)?\d{8}-\d{6}(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?\.jsonl$/;

/** Newest by mtime wins; the name breaks a tie so the choice is stable. */
const newer = (a: RunFile, b: RunFile) =>
  a.mtime > b.mtime || (a.mtime === b.mtime && a.name > b.name);

/**
 * `tasks`: task numbers whose files may be archived or deleted. Files of other tasks are left
 * alone, except that they still count when picking the newest log of each profile.
 */
export function planRetention(
  listing: RunsListing,
  tasks: ReadonlySet<string>,
  settings: RunsRetention,
): RetentionDecision[] {
  const newest = new Map<string, RunFile>();
  for (const file of listing.root) {
    const m = JSONL.exec(file.name);
    if (!m) continue;
    const key = m[1] ?? "";
    const best = newest.get(key);
    if (!best || newer(file, best)) newest.set(key, file);
  }
  const keepNewest = new Set([...newest.values()].map((f) => f.name));
  const recent = listing.now - settings.recentMinutes * 60;

  const decisions: RetentionDecision[] = [];
  for (const file of [...listing.root].sort((a, b) => a.name.localeCompare(b.name))) {
    const task = logTask(file.name);
    if (task === null || !tasks.has(task)) continue;
    const decide = (action: RetentionDecision["action"], reason: string) =>
      decisions.push({ name: file.name, action, reason });
    if (file.live) decide("keep", "a running worker has it open");
    else if (file.mtime > recent)
      decide("keep", `written in the last ${String(settings.recentMinutes)} min`);
    else if (file.name.endsWith("-current")) decide("delete", "current marker");
    else if (file.name.endsWith(".err") && file.size === 0) decide("delete", "empty .err");
    else if (keepNewest.has(file.name)) decide("keep", "newest log of its profile (quota.ts)");
    else decide("archive", "task log");
  }

  // The cap works on the archive as listed: files archived by this very run count next time.
  const cutoff = listing.now - settings.archiveMaxAgeDays * 86400;
  const live = [...listing.archive].sort(
    (a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name),
  );
  const drop = (file: RunFile, reason: string) =>
    decisions.push({ name: `archive/${file.name}`, action: "delete", reason });
  const young = live.filter((f) => f.mtime >= cutoff);
  for (const file of live.filter((f) => f.mtime < cutoff)) {
    drop(file, `older than ${String(settings.archiveMaxAgeDays)} days`);
  }
  let total = young.reduce((sum, f) => sum + f.size, 0);
  for (const file of young) {
    if (total <= settings.archiveMaxBytes) break;
    total -= file.size;
    drop(file, `archive over ${String(Math.round(settings.archiveMaxBytes / 1048576))} MB`);
  }
  return decisions;
}

/**
 * Bash payload (no quotes, backslashes or newlines, see wslCommand) printing the listing:
 * `@@now`, `@@open` (files held open by any process), `@@root`, `@@archive`.
 */
export const RUNS_LISTING = [
  `d=$HOME/${RUNS_DIR_FROM_HOME}`,
  "echo @@now; date +%s",
  `echo @@open; readlink /proc/[0-9]*/fd/* 2>/dev/null | grep ${RUNS_DIR_FROM_HOME}/ | sort -u`,
  "echo @@root; cd $d 2>/dev/null && stat -c '%n|%s|%Y' omi-* 2>/dev/null",
  "echo @@archive; cd $d/archive 2>/dev/null && stat -c '%n|%s|%Y' * 2>/dev/null",
  "true",
].join("; ");

// Names reach the shell unquoted, so anything unusual is ignored rather than escaped.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export function parseRunsListing(stdout: string): RunsListing {
  const sections = new Map<string, string[]>();
  let current = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("@@")) {
      current = line.slice(2).trim();
      sections.set(current, []);
    } else if (line.trim()) sections.get(current)?.push(line.trim());
  }
  const open = new Set((sections.get("open") ?? []).map((p) => p.split("/").at(-1) ?? p));
  const files = (key: string): RunFile[] =>
    (sections.get(key) ?? []).flatMap((line) => {
      const [name = "", size = "", mtime = ""] = line.split("|");
      if (!SAFE_NAME.test(name) || !/^\d+$/.test(size) || !/^\d+$/.test(mtime)) return [];
      return [{ name, size: Number(size), mtime: Number(mtime), live: open.has(name) }];
    });
  const now = Number((sections.get("now") ?? [])[0]);
  if (!Number.isFinite(now)) throw new Error("runs listing has no timestamp");
  return { now, root: files("root"), archive: files("archive") };
}

/**
 * One payload for all actions; null when there is nothing to do. A file that vanished since the
 * listing is skipped, so a re-run or a race never fails on it. Archive = move, then gzip.
 */
export function retentionScript(decisions: readonly RetentionDecision[]): string | null {
  const names = (action: "archive" | "delete") =>
    decisions.filter((d) => d.action === action).map((d) => d.name);
  const archive = names("archive");
  const remove = names("delete");
  const parts: string[] = [];
  if (archive.length + remove.length === 0) return null;
  if (archive.length > 0) {
    parts.push(
      `mkdir -p archive`,
      `for f in ${archive.join(" ")}; do if [ -f $f ]; then mv -f $f archive/$f && gzip -f archive/$f; fi; done`,
    );
  }
  if (remove.length > 0) parts.push(`rm -f -- ${remove.join(" ")}`);
  return [`cd $HOME/${RUNS_DIR_FROM_HOME}`, ...parts].join(" && ");
}
