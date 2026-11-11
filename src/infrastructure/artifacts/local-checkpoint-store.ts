import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  checkpointKindSchema,
  checkpointManifestPath,
} from "../../application/contracts/checkpoint.js";
import type { CheckpointStatus } from "../../application/contracts/checkpoint.js";
import {
  assertCredentialFree,
  type CredentialPolicy,
} from "../../application/contracts/credential-input.js";
import { identifierSchema } from "../../application/contracts/identifiers.js";
import {
  CheckpointError,
  type CheckpointRecord,
  type CheckpointSave,
  type CheckpointStore,
} from "../../application/ports/checkpoint-store.js";
import type { StateDatabase } from "../persistence/sqlite/sqlite-connection.js";
import { runInTransaction } from "../persistence/sqlite/sqlite-transaction.js";
import { hasFsCode, resolveArtifactPath, syncDirectory } from "./artifact-path.js";

/**
 * Points of a save where a process can die. A test hook may throw at one to leave exactly the
 * state a crash there would leave: `row-pending` (row, no file), `temp-synced` (row, durable
 * temp, no manifest), `renamed` (row, manifest, status not yet `valid`).
 */
export type CheckpointBoundary = "row-pending" | "temp-synced" | "renamed";

export interface LocalCheckpointStoreOptions {
  readonly policy?: CredentialPolicy;
  readonly onBoundary?: (boundary: CheckpointBoundary) => void;
}

interface Row {
  id: string;
  run_id: string;
  step_run_id: string | null;
  snapshot_kind: string;
  manifest_path: string;
  manifest_hash: string;
  git_revision: string | null;
  status: CheckpointStatus;
  created_at: string;
}

const COLUMNS =
  "id, run_id, step_run_id, snapshot_kind, manifest_path, manifest_hash, git_revision, status, created_at";

/** Best effort: a leftover temp is reported as an orphan by reconcile, never masks the failure. */
function discard(temp: string, fd: number | undefined): void {
  try {
    if (fd !== undefined) fs.closeSync(fd);
  } catch {
    // Keep the original failure.
  }
  try {
    fs.rmSync(temp, { force: true });
  } catch {
    // Same.
  }
}

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function toRecord(row: Row): CheckpointRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepRunId: row.step_run_id ?? undefined,
    kind: checkpointKindSchema.parse(row.snapshot_kind),
    manifestPath: row.manifest_path,
    manifestHash: row.manifest_hash,
    gitRevision: row.git_revision ?? undefined,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * Two-phase, crash-detectable checkpoint persistence under the artifact root.
 *
 * save: (1) commit a `pending` row, (2) write a temp file, fsync it, (3) rename it into place and
 * fsync the directory, (4) flip the row to `valid`. The row is only ever `valid` when the file was
 * durable and complete first, so the DB never points at an unfinished file as a resume point. A
 * crash in between leaves a `pending` row (and possibly a temp or a manifest) that `reconcile`
 * marks `interrupted`; such a checkpoint is never resumed from, even when its bytes look intact.
 * Files are never deleted here: unreferenced ones are reported for later collection.
 */
export function createLocalCheckpointStore(
  root: string,
  db: StateDatabase,
  options: LocalCheckpointStoreOptions = {},
): CheckpointStore {
  if (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory()) {
    throw new CheckpointError("INVALID_INPUT");
  }
  const canonicalRoot = fs.realpathSync(root);
  const policy = options.policy ?? {};
  const hook = options.onBoundary ?? ((): void => undefined);

  const exists = db.prepare("SELECT 1 FROM checkpoints WHERE id = ? OR manifest_path = ?");
  const insert = db.prepare(
    `INSERT INTO checkpoints (${COLUMNS}, status_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  );
  const select = db.prepare(`SELECT ${COLUMNS} FROM checkpoints WHERE id = ?`);
  const validRows = db.prepare(
    `SELECT ${COLUMNS} FROM checkpoints WHERE run_id = ? AND status = 'valid' ORDER BY created_at DESC, rowid DESC`,
  );
  const openRows = db.prepare(
    `SELECT ${COLUMNS} FROM checkpoints WHERE run_id = ? AND status IN ('pending', 'valid') ORDER BY created_at, rowid`,
  );
  const promote = db.prepare(
    "UPDATE checkpoints SET status = 'valid', status_changed_at = ? WHERE id = ? AND status = 'pending'",
  );
  const interrupt = db.prepare(
    "UPDATE checkpoints SET status = 'interrupted', status_changed_at = ? WHERE id = ? AND status IN ('pending', 'valid')",
  );

  /** `bytes` when the file is present, regular and matches its recorded hash. */
  function verified(row: Row): Uint8Array | undefined {
    let fd: number | undefined;
    try {
      const target = resolveArtifactPath(canonicalRoot, row.manifest_path, false);
      fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(fd).isFile()) return undefined;
      const bytes = fs.readFileSync(fd);
      return hash(bytes) === row.manifest_hash ? bytes : undefined;
    } catch (error) {
      if (hasFsCode(error, "ENOENT") || hasFsCode(error, "ELOOP")) return undefined;
      // resolveArtifactPath reports a missing or non-regular file as an ArtifactError.
      if (error instanceof Error && error.name === "ArtifactError") return undefined;
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  return {
    save(input: CheckpointSave): CheckpointRecord {
      if (
        !identifierSchema.safeParse(input.id).success ||
        !identifierSchema.safeParse(input.runId).success ||
        !checkpointKindSchema.safeParse(input.kind).success
      ) {
        throw new CheckpointError("INVALID_INPUT");
      }
      const text = new TextDecoder().decode(input.bytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new CheckpointError("INVALID_INPUT");
      }
      // Fail before any row or file exists: a rejected snapshot leaves no trace.
      assertCredentialFree(text, policy);
      assertCredentialFree(parsed, policy);

      const bytes = Buffer.from(input.bytes);
      const sha256 = hash(bytes);
      const path = checkpointManifestPath(input.runId, input.id);
      if (exists.get(input.id, path) !== undefined) throw new CheckpointError("ALREADY_EXISTS");

      insert.run(
        input.id,
        input.runId,
        input.stepRunId ?? null,
        input.kind,
        path,
        sha256,
        input.gitRevision ?? null,
        input.createdAt,
        input.createdAt,
      );
      hook("row-pending");

      const target = resolveArtifactPath(canonicalRoot, path, true);
      if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
        // An unreferenced file already sits where this checkpoint belongs: never overwrite it.
        throw new CheckpointError("ALREADY_EXISTS");
      }
      const directory = dirname(target);
      const temp = join(directory, `.checkpoint-${randomUUID()}.tmp`);
      let fd: number | undefined;
      try {
        fd = fs.openSync(temp, "wx", 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
      } catch (error) {
        discard(temp, fd);
        throw error;
      }
      hook("temp-synced");
      try {
        fs.renameSync(temp, target);
        syncDirectory(directory);
      } catch (error) {
        discard(temp, undefined);
        throw error;
      }
      hook("renamed");

      const changed = runInTransaction(db, () => promote.run(input.createdAt, input.id).changes);
      // Someone reconciled this row to `interrupted` while we wrote: that verdict stands.
      if (changed !== 1) throw new CheckpointError("INCONSISTENT");
      return toRecord(select.get(input.id) as Row);
    },

    get(checkpointId) {
      const row = select.get(checkpointId) as Row | undefined;
      return row === undefined ? undefined : toRecord(row);
    },

    latestValid(runId, at) {
      for (const row of validRows.all(runId) as Row[]) {
        const bytes = verified(row);
        if (bytes !== undefined) return { record: toRecord(row), bytes };
        interrupt.run(at, row.id);
      }
      return undefined;
    },

    reconcile(runId, at) {
      const interrupted: string[] = [];
      for (const row of openRows.all(runId) as Row[]) {
        // A `pending` row means the save never finished. Even if its file is intact it is not
        // trusted: the next checkpoint supersedes it.
        if (row.status === "pending" || verified(row) === undefined) {
          if (interrupt.run(at, row.id).changes === 1) interrupted.push(row.id);
        }
      }

      const referenced = new Set(
        (validRows.all(runId) as Row[]).map((row) => basename(row.manifest_path)),
      );
      const orphanFiles: string[] = [];
      if (!identifierSchema.safeParse(runId).success) throw new CheckpointError("INVALID_INPUT");
      const base = join(canonicalRoot, "checkpoints", runId);
      const stat = fs.lstatSync(base, { throwIfNoEntry: false });
      // No directory yet means nothing can be orphaned; a symlink is never followed.
      if (stat?.isDirectory() === true) {
        for (const name of fs.readdirSync(base).sort()) {
          if (!referenced.has(name)) orphanFiles.push(`checkpoints/${runId}/${name}`);
        }
      }
      return { interrupted, orphanFiles };
    },
  };
}
