import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialInputError } from "../../../src/application/contracts/credential-input.ts";
import {
  CheckpointError,
  type CheckpointSave,
  type CheckpointStore,
} from "../../../src/application/ports/checkpoint-store.ts";
import {
  createLocalCheckpointStore,
  type CheckpointBoundary,
} from "../../../src/infrastructure/artifacts/local-checkpoint-store.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";

const MIGRATIONS = resolve(import.meta.dirname, "../../../migrations");
const T0 = "2026-11-11T00:00:00.000Z";
const T1 = "2026-11-11T00:01:00.000Z";
const T2 = "2026-11-11T00:02:00.000Z";
const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Simulates the process dying at a boundary: nothing after it runs, nothing is cleaned up. */
class SimulatedCrash extends Error {
  override readonly name = "SimulatedCrash";
}

let directory: string;
let root: string;
let db: StateDatabase;
let crashAt: CheckpointBoundary | undefined;
let afterBoundary: ((boundary: CheckpointBoundary) => void) | undefined;
let store: CheckpointStore;

beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "omi-checkpoint-"));
  root = join(directory, "artifacts");
  fs.mkdirSync(root);
  db = openStateDatabase(join(directory, "state.db"));
  applyMigrations(db, loadMigrations(MIGRATIONS));
  db.exec(`
    INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', 'acme/app', 'h', '${T0}', '${T0}');
    INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at)
      VALUES ('t', 'p', 'I_1', 1, 'h', '${T0}', '{}', '${T0}');
    INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, created_at, updated_at)
      VALUES ('run-1', 't', 'h', 'running', 'implementation', '${T0}', '${T0}');
    INSERT INTO step_runs (id, run_id, step_key, status, created_at, updated_at)
      VALUES ('step-1', 'run-1', 'implement', 'running', '${T0}', '${T0}');
  `);
  crashAt = undefined;
  afterBoundary = undefined;
  store = createLocalCheckpointStore(root, db, {
    onBoundary: (boundary) => {
      afterBoundary?.(boundary);
      if (boundary === crashAt) throw new SimulatedCrash();
    },
  });
});

afterEach(() => {
  if (db.open) db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const manifestBytes = (text = "first"): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ note: text }));

function save(id: string, createdAt = T0, bytes = manifestBytes(id)): CheckpointSave {
  return { id, runId: "run-1", stepRunId: "step-1", kind: "before-dispatch", bytes, createdAt };
}

const status = (id: string): string | undefined =>
  (
    db.prepare("SELECT status FROM checkpoints WHERE id = ?").get(id) as
      { status: string } | undefined
  )?.status;
const dir = (): string => join(root, "checkpoints", "run-1");
const files = (): string[] => (fs.existsSync(dir()) ? fs.readdirSync(dir()).sort() : []);

describe("atomic write", () => {
  it("publishes the file and the valid row together, with agreeing path and hash", () => {
    const bytes = manifestBytes("hello");
    const record = store.save(save("cp-1", T0, bytes));

    expect(record).toMatchObject({
      id: "cp-1",
      status: "valid",
      manifestPath: "checkpoints/run-1/cp-1.json",
      manifestHash: digest(bytes),
      stepRunId: "step-1",
    });
    expect(files()).toEqual(["cp-1.json"]);
    expect(digest(fs.readFileSync(join(dir(), "cp-1.json")))).toBe(record.manifestHash);
    expect(fs.statSync(join(dir(), "cp-1.json")).mode & 0o777).toBe(0o600);
    const latest = store.latestValid("run-1", T1);
    expect(latest?.record.id).toBe("cp-1");
    expect(Buffer.from(latest?.bytes ?? []).equals(Buffer.from(bytes))).toBe(true);
  });

  it("selects the last saved checkpoint after the wall clock steps back", () => {
    store.save(save("before-rollback", T1));
    store.save(save("after-rollback", T0));
    // Resume must see the paused workspace, not an older before-dispatch Git snapshot.
    const restarted = createLocalCheckpointStore(root, db);
    expect(restarted.latestValid("run-1", T2)?.record.id).toBe("after-rollback");
  });

  it("never overwrites: a second save of the same id fails and the first stays valid", () => {
    store.save(save("cp-1"));
    expect(() => store.save(save("cp-1", T1, manifestBytes("other")))).toThrow(
      expect.objectContaining({ code: "ALREADY_EXISTS" }) as Error,
    );
    expect(status("cp-1")).toBe("valid");
    expect(store.latestValid("run-1", T1)?.record.manifestHash).toBe(digest(manifestBytes("cp-1")));
  });

  it("refuses non-JSON and invalid ids before creating any row or file", () => {
    expect(() => store.save(save("cp-1", T0, new TextEncoder().encode("not json")))).toThrow(
      CheckpointError,
    );
    expect(() => store.save({ ...save("../escape"), id: "../escape" })).toThrow(CheckpointError);
    expect(db.prepare("SELECT count(*) AS n FROM checkpoints").get()).toEqual({ n: 0 });
    expect(files()).toEqual([]);
  });

  it("refuses a credential in the manifest before any row or file exists (ADR-0022)", () => {
    const secret = new TextEncoder().encode(JSON.stringify({ note: "ghp_abcdefghijklmnop1234" }));
    expect(() => store.save(save("cp-1", T0, secret))).toThrow(CredentialInputError);
    const keyed = new TextEncoder().encode(JSON.stringify({ token: "x" }));
    expect(() => store.save(save("cp-2", T0, keyed))).toThrow(CredentialInputError);
    expect(db.prepare("SELECT count(*) AS n FROM checkpoints").get()).toEqual({ n: 0 });
    expect(files()).toEqual([]);
  });

  it("a rename failure leaves no temp file and the row non-valid", () => {
    fs.mkdirSync(join(dir(), "cp-1.json"), { recursive: true });
    expect(() => store.save(save("cp-1"))).toThrow();
    expect(files()).toEqual(["cp-1.json"]);
    expect(status("cp-1")).toBe("pending");
    expect(store.latestValid("run-1", T1)).toBeUndefined();
  });
});

describe("crash at each file/DB boundary", () => {
  beforeEach(() => {
    store.save(save("cp-good", T0));
  });

  it("before the file: a pending row and no file is marked interrupted", () => {
    crashAt = "row-pending";
    expect(() => store.save(save("cp-1", T1))).toThrow(SimulatedCrash);

    expect(status("cp-1")).toBe("pending");
    expect(files()).toEqual(["cp-good.json"]);
    expect(store.get("cp-1")?.status).toBe("pending");
    expect(store.latestValid("run-1", T2)?.record.id).toBe("cp-good");

    expect(store.reconcile("run-1", T2)).toEqual({
      interrupted: ["cp-1"],
      orphanFiles: [],
      problems: [{ checkpointId: "cp-1", reason: "CHECKPOINT_FILE_MISSING" }],
    });
    expect(status("cp-1")).toBe("interrupted");
  });

  it("after the temp is durable: the temp is an orphan, the row interrupted, no manifest exists", () => {
    crashAt = "temp-synced";
    expect(() => store.save(save("cp-1", T1))).toThrow(SimulatedCrash);

    expect(files().filter((name) => name.startsWith(".checkpoint-"))).toHaveLength(1);
    expect(files()).not.toContain("cp-1.json");
    expect(status("cp-1")).toBe("pending");

    const outcome = store.reconcile("run-1", T2);
    expect(outcome.interrupted).toEqual(["cp-1"]);
    expect(outcome.orphanFiles).toHaveLength(1);
    expect(outcome.orphanFiles[0]).toMatch(/^checkpoints\/run-1\/\.checkpoint-.+\.tmp$/);
    expect(status("cp-1")).toBe("interrupted");
    // Reconcile reports orphans; it never deletes anything.
    expect(files()).toHaveLength(2);
  });

  it("after the rename but before the row is valid: an intact file is still not trusted", () => {
    crashAt = "renamed";
    expect(() => store.save(save("cp-1", T1))).toThrow(SimulatedCrash);

    expect(files()).toEqual(["cp-1.json", "cp-good.json"]);
    expect(digest(fs.readFileSync(join(dir(), "cp-1.json")))).toBe(digest(manifestBytes("cp-1")));
    expect(status("cp-1")).toBe("pending");
    expect(store.latestValid("run-1", T2)?.record.id).toBe("cp-good");

    expect(store.reconcile("run-1", T2)).toEqual({
      interrupted: ["cp-1"],
      orphanFiles: ["checkpoints/run-1/cp-1.json"],
      problems: [{ checkpointId: "cp-1", reason: "CHECKPOINT_INCOMPLETE" }],
    });
    expect(store.get("cp-1")?.status).toBe("interrupted");
    expect(store.latestValid("run-1", T2)?.record.id).toBe("cp-good");
  });

  it("a save that loses to reconcile never flips an interrupted row back to valid", () => {
    afterBoundary = (boundary) => {
      if (boundary === "renamed") store.reconcile("run-1", T2);
    };
    expect(() => store.save(save("cp-1", T1))).toThrow(
      expect.objectContaining({ code: "INCONSISTENT" }) as Error,
    );
    expect(status("cp-1")).toBe("interrupted");
  });

  it("reconcile is idempotent and leaves valid checkpoints alone", () => {
    crashAt = "row-pending";
    expect(() => store.save(save("cp-1", T1))).toThrow(SimulatedCrash);
    store.reconcile("run-1", T2);
    expect(store.reconcile("run-1", T2)).toEqual({
      interrupted: [],
      orphanFiles: [],
      problems: [{ checkpointId: "cp-1", reason: "CHECKPOINT_FILE_MISSING" }],
    });
    expect(status("cp-good")).toBe("valid");
  });
});

describe("a snapshot damaged after it was written", () => {
  beforeEach(() => {
    store.save(save("cp-old", T0));
    store.save(save("cp-new", T1));
  });

  it("a truncated (partial) file is marked interrupted and the previous valid one is used", () => {
    const file = join(dir(), "cp-new.json");
    fs.truncateSync(file, 5);

    expect(store.latestValid("run-1", T2)?.record.id).toBe("cp-old");
    expect(status("cp-new")).toBe("interrupted");
  });

  it("a missing file is detected", () => {
    fs.rmSync(join(dir(), "cp-new.json"));
    expect(store.reconcile("run-1", T2).interrupted).toEqual(["cp-new"]);
    expect(store.latestValid("run-1", T2)?.record.id).toBe("cp-old");
  });

  it("a same-size altered file fails the hash check", () => {
    const file = join(dir(), "cp-new.json");
    const original = fs.readFileSync(file);
    const altered = Buffer.from(original);
    altered[altered.length - 3] = altered[altered.length - 3] === 0x78 ? 0x79 : 0x78;
    fs.writeFileSync(file, altered);

    expect(store.reconcile("run-1", T2).interrupted).toEqual(["cp-new"]);
  });

  it("a symlink in place of the manifest is never followed", () => {
    const file = join(dir(), "cp-new.json");
    const outside = join(directory, "elsewhere.json");
    fs.writeFileSync(outside, fs.readFileSync(file));
    fs.rmSync(file);
    fs.symlinkSync(outside, file);

    expect(store.latestValid("run-1", T2)?.record.id).toBe("cp-old");
    expect(status("cp-new")).toBe("interrupted");
  });

  it("with no valid checkpoint left there is nothing to resume from", () => {
    fs.rmSync(join(dir(), "cp-new.json"));
    fs.rmSync(join(dir(), "cp-old.json"));
    expect(store.latestValid("run-1", T2)).toBeUndefined();
    expect(status("cp-old")).toBe("interrupted");
  });
});

describe("schema", () => {
  it("rejects a status outside pending/valid/interrupted", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO checkpoints (id, run_id, snapshot_kind, manifest_path, manifest_hash, created_at, status)
           VALUES ('x', 'run-1', 'pause', 'checkpoints/x.json', 'h', '${T0}', 'done')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/);
  });

  it("treats rows that predate migration 0007 as interrupted, never as valid", () => {
    const old = openStateDatabase(join(directory, "old.db"));
    try {
      applyMigrations(
        old,
        loadMigrations(MIGRATIONS).filter((migration) => migration.version <= 6),
      );
      old.exec(`
        INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p', 'r', 'h', '${T0}', '${T0}');
        INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at)
          VALUES ('t', 'p', 'I_1', 1, 'h', '${T0}', '{}', '${T0}');
        INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, created_at, updated_at)
          VALUES ('r', 't', 'h', 'running', 'implementation', '${T0}', '${T0}');
        INSERT INTO checkpoints (id, run_id, snapshot_kind, manifest_path, manifest_hash, created_at)
          VALUES ('legacy', 'r', 'business', 'checkpoints/legacy.json', 'h', '${T0}');
      `);
      applyMigrations(old, loadMigrations(MIGRATIONS));
      expect(old.prepare("SELECT status FROM checkpoints WHERE id = 'legacy'").get()).toEqual({
        status: "interrupted",
      });
    } finally {
      old.close();
    }
  });
});
