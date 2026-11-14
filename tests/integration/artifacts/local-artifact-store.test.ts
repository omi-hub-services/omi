import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  ArtifactReference,
  ArtifactWrite,
} from "../../../src/application/contracts/artifact.ts";
import {
  ArtifactError,
  type ArtifactAdopter,
  type ArtifactStore,
} from "../../../src/application/ports/artifact-store.ts";
import {
  assertCredentialFree,
  CredentialInputError,
} from "../../../src/application/contracts/credential-input.ts";
import { contextPacketSchema } from "../../../src/application/contracts/context.ts";
import { assembleContext } from "../../../src/application/services/assemble-context.ts";
import { createLocalArtifactStore } from "../../../src/infrastructure/artifacts/local-artifact-store.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";

const migrations = resolve(import.meta.dirname, "../../../migrations");
const repoRoot = resolve(import.meta.dirname, "../../..");
const at = "2026-11-10T00:00:00.000Z";
const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
let directory: string;
let root: string;
let db: StateDatabase;
let store: ArtifactStore & ArtifactAdopter;

beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "omi-artifacts-"));
  root = join(directory, "artifacts");
  fs.mkdirSync(root);
  db = openStateDatabase(join(directory, "state.db"));
  applyMigrations(db, loadMigrations(migrations));
  store = createLocalArtifactStore(root, db);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (db.open) db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function write(overrides: Partial<ArtifactWrite> = {}): ArtifactReference {
  return store.write({
    id: "artifact-1",
    path: "report.txt",
    bytes: Buffer.from("verified evidence\r\n"),
    classification: "report",
    createdAt: at,
    ...overrides,
  });
}

function rowCount(): number {
  return (db.prepare("SELECT count(*) AS n FROM artifacts").get() as { n: number }).n;
}

describe("durable artifact publication", () => {
  it.each([
    "AGENTS.md",
    "docs/engineering/design-patterns.md",
    "docs/architecture/architecture.md",
    "docs/operations/compatibility.md",
    "src/application/services/assemble-context.ts",
  ])("accepts the real repository file %s as artifact input", (path) => {
    const bytes = fs.readFileSync(join(repoRoot, path));
    expect(() => {
      assertCredentialFree(bytes.toString("utf8"));
    }).not.toThrow();
    const reference = write({ bytes });
    expect(Buffer.from(store.read(reference))).toEqual(bytes);
  });

  it("hashes exact binary and UTF-8 bytes, verifies reads and lists sizes in a selective manifest", () => {
    const binary = Uint8Array.from([0, 255, 128, 13, 10]);
    const text = Buffer.from("Bằng chứng\r\n");
    const a = write({ bytes: binary });
    const b = write({ id: "artifact-2", path: "nested/evidence.md", bytes: text });
    write({ id: "artifact-3", path: "unselected.txt" });
    expect(a.sha256).toBe(digest(binary));
    expect(b.sha256).toBe(digest(text));
    expect(Buffer.from(store.read(a))).toEqual(Buffer.from(binary));
    expect(store.manifest([b, a])).toEqual({
      schemaVersion: 1,
      artifacts: [
        { ...b, size: text.byteLength },
        { ...a, size: binary.byteLength },
      ],
    });
    expect(fs.readdirSync(root)).toEqual(["nested", "report.txt", "unselected.txt"]);
    expect(fs.statSync(join(root, a.path)).mode & 0o777).toBe(0o600);
  });

  it("can persist and read its manifest as another immutable artifact", () => {
    const a = write({ bytes: new Uint8Array() });
    const manifest = store.manifest([a]);
    const ref = write({
      id: "manifest",
      path: "manifest.json",
      bytes: Buffer.from(JSON.stringify(manifest)),
      classification: "manifest",
    });
    expect(JSON.parse(Buffer.from(store.read(ref)).toString("utf8"))).toEqual(manifest);
    expect(manifest.artifacts[0]?.size).toBe(0);
  });

  it("assembles a v1 packet with a real curated skill pin and a sourced summary artifact", () => {
    const lockJson: unknown = JSON.parse(
      fs.readFileSync(
        resolve(
          import.meta.dirname,
          "../../../templates/project/.omi-squad/provenance/skills.lock.json",
        ),
        "utf8",
      ),
    );
    const lock = z
      .object({ skills: z.array(z.object(contextPacketSchema.shape.skillsManifest.element.shape)) })
      .parse(lockJson);
    const skill = lock.skills.find((entry) => entry.id === "minimal-change");
    if (skill === undefined) throw new Error("curated minimal-change skill missing");
    const source = write({
      path: "analysis/source.md",
      bytes: Buffer.from("Detailed source evidence"),
    });
    const summary = { summary: "Evidence supports the approved scope", source };
    const summaryRef = write({
      id: "summary",
      path: "analysis/summary.json",
      bytes: Buffer.from(JSON.stringify(summary)),
      classification: "sourced-summary",
    });
    const packet = assembleContext({
      context: {
        schemaVersion: 1,
        runId: "run-1",
        stepId: "implement",
        attemptId: "attempt-1",
        taskSnapshot: {
          issueNumber: 14,
          title: "Artifact storage",
          body: '## Objective\nStore selective artifact references, keeping credentials local.\n\n## Acceptance criteria\n- Atomic publication and verified hashes\n- Preserve evidence such as `const x = 5;`, `a == b` and `<div class="x">`\n\n<!-- omi-squad:plan-key=OMI-012 -->',
        },
        acceptanceCriteria: ["Atomic writes"],
        businessBaselineHash: digest("approved scope"),
        role: "developer",
        capabilityProfile: { id: "coding", min_effort: "high" },
        workspace: { path: "/work/app" },
        previousFindings: [],
        expectedOutputSchema: "implementation-result-v1",
        allowedScope: { paths: ["src/"] },
        approvalRefs: [],
      },
      skills: [{ roles: ["developer"], steps: ["implement"], reference: skill }],
      rules: [],
      inputs: [{ roles: ["developer"], steps: ["implement"], reference: summaryRef }],
    });
    expect(packet.skillsManifest).toEqual([skill]);
    expect(packet.inputArtifacts).toEqual([summaryRef]);
    expect(JSON.stringify(packet)).not.toContain(summary.summary);
    expect(JSON.parse(Buffer.from(store.read(summaryRef)).toString("utf8"))).toEqual(summary);
    expect(store.manifest(packet.inputArtifacts).artifacts).toHaveLength(1);
    const contextRef = write({
      id: "context",
      path: "context.json",
      classification: "context",
      bytes: Buffer.from(JSON.stringify(packet)),
    });
    expect(
      contextPacketSchema.parse(JSON.parse(Buffer.from(store.read(contextRef)).toString("utf8"))),
    ).toEqual(packet);
  });

  it("fsyncs the file outside the transaction, then links, unlinks temp, syncs directory and records the DB reference inside it", () => {
    const events: string[] = [];
    const fsync = fs.fsyncSync;
    const link = fs.linkSync;
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      const isDirectory = fs.fstatSync(fd).isDirectory();
      events.push(isDirectory ? "directory-sync" : "file-sync");
      expect(db.inTransaction).toBe(isDirectory);
      expect(rowCount()).toBe(0);
      fsync(fd);
    });
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      events.push("link");
      expect(db.inTransaction).toBe(true);
      expect(dirname(String(from))).toBe(dirname(String(to)));
      expect(rowCount()).toBe(0);
      link(from, to);
    });
    vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
      events.push("temp-unlink");
      expect(db.inTransaction).toBe(true);
      expect(fs.statSync(join(root, "report.txt")).ino).toBe(fs.statSync(path).ino);
      unlink(path);
    });
    db.function("publication_observed", () => {
      expect(fs.readFileSync(join(root, "report.txt"), "utf8")).toBe("verified evidence\r\n");
      events.push("db-reference");
      return 1;
    });
    db.exec(
      "CREATE TRIGGER observe_artifact BEFORE INSERT ON artifacts BEGIN SELECT publication_observed(); END",
    );
    write();
    expect(events).toEqual(["file-sync", "link", "temp-unlink", "directory-sync", "db-reference"]);
  });

  it.each(["writeFileSync", "fsyncSync", "linkSync"] as const)(
    "cleans temp and records nothing when %s throws before publication",
    (operation) => {
      vi.spyOn(fs, operation).mockImplementationOnce(() => {
        throw new Error("injected disk failure");
      });
      expect(() => write()).toThrow("injected disk failure");
      expect(rowCount()).toBe(0);
      expect(fs.readdirSync(root)).toEqual([]);
    },
  );

  it("removes its publication if directory sync fails and permits retry", () => {
    const failure = Object.assign(new Error("disk failure"), { code: "EIO" });
    const fsync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync")
      .mockImplementationOnce(fsync)
      .mockImplementationOnce(() => {
        throw failure;
      });
    expect(() => write()).toThrow(failure);
    expect(rowCount()).toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(store.read(write()).byteLength).toBeGreaterThan(0);
  });

  it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"])(
    "reports typed unsupported hard links for %s and cleans temp",
    (code) => {
      vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("unsupported filesystem operation"), { code });
      });
      expect(() => write()).toThrow(new ArtifactError("HARD_LINK_UNSUPPORTED"));
      expect(rowCount()).toBe(0);
      expect(fs.readdirSync(root)).toEqual([]);
      expect(store.read(write()).byteLength).toBeGreaterThan(0);
    },
  );

  it("rolls back its target after a temp unlink failure, cleans temp and permits retry", () => {
    const failure = new Error("initial temp unlink failure");
    vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      write();
      expect.fail("publication should fail");
    } catch (error) {
      expect(error).toBe(failure);
    }
    expect(rowCount()).toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(store.read(write()).byteLength).toBeGreaterThan(0);
  });

  it("preserves the original temp unlink error even if its cleanup retry also fails", () => {
    const failure = new Error("initial temp unlink failure");
    const unlink = fs.unlinkSync;
    let tempUnlinks = 0;
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (String(path).endsWith(".tmp")) {
        tempUnlinks += 1;
        throw tempUnlinks === 1 ? failure : new Error("secondary cleanup failure");
      }
      unlink(path);
    });
    try {
      write();
      expect.fail("publication should fail");
    } catch (error) {
      expect(error).toBe(failure);
    }
    expect(tempUnlinks).toBe(2);
    expect(rowCount()).toBe(0);
    expect(fs.existsSync(join(root, "report.txt"))).toBe(false);
    expect(fs.readdirSync(root)).toHaveLength(1);
    spy.mockRestore();
    expect(store.read(write()).byteLength).toBeGreaterThan(0);
  });

  it("preserves an insert error even if target rollback fails", () => {
    const failure = new Error("injected insert failure");
    const unlink = fs.unlinkSync;
    db.function("reject_artifact", () => {
      throw failure;
    });
    db.exec(
      "CREATE TRIGGER reject_artifact BEFORE INSERT ON artifacts BEGIN SELECT reject_artifact(); END",
    );
    vi.spyOn(fs, "unlinkSync")
      .mockImplementationOnce(unlink)
      .mockImplementationOnce(() => {
        throw new Error("secondary rollback failure");
      });
    try {
      write();
      expect.fail("publication should fail");
    } catch (error) {
      expect(error).toBe(failure);
    }
    expect(rowCount()).toBe(0);
  });

  it.each(["file", "symlink"])(
    "keeps an outside %s replacing its target before insert fails",
    (kind) => {
      const target = join(root, "report.txt");
      const outside = join(directory, "outside.txt");
      fs.writeFileSync(outside, "outside writer evidence");
      db.function("replace_artifact", () => {
        if (kind === "file") fs.renameSync(outside, target);
        else {
          fs.unlinkSync(target);
          fs.symlinkSync(outside, target);
        }
        return 1;
      });
      db.exec(
        "CREATE TRIGGER replace_artifact BEFORE INSERT ON artifacts BEGIN SELECT replace_artifact(); SELECT RAISE(ABORT, 'injected insert failure'); END",
      );
      expect(() => write()).toThrow("injected insert failure");
      expect(rowCount()).toBe(0);
      expect(fs.readFileSync(target, "utf8")).toBe("outside writer evidence");
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(kind === "symlink");
    },
  );

  it("tolerates an explicitly unsupported directory fsync", () => {
    const fsync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory())
        throw Object.assign(new Error("unsupported"), { code: "EINVAL" });
      fsync(fd);
    });
    expect(store.read(write()).byteLength).toBeGreaterThan(0);
    expect(rowCount()).toBe(1);
  });

  it("rolls back a failed DB insertion without an orphan and permits retry of the same path", () => {
    expect(() => write({ producerAttemptId: "missing-attempt" })).toThrow(/FOREIGN KEY/);
    expect(rowCount()).toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
    const ref = write();
    expect(rowCount()).toBe(1);
    expect(Buffer.from(store.read(ref)).toString()).toBe("verified evidence\r\n");
  });

  it("also removes its target when a deferred foreign key fails at commit", () => {
    const inserted = vi.fn(() => 1);
    db.function("artifact_inserted", inserted);
    db.exec(
      "CREATE TRIGGER artifact_inserted AFTER INSERT ON artifacts BEGIN SELECT artifact_inserted(); END",
    );
    db.pragma("defer_foreign_keys = ON");
    expect(() => write({ producerAttemptId: "missing-attempt" })).toThrow(/FOREIGN KEY/);
    expect(inserted).toHaveBeenCalledOnce();
    expect(rowCount()).toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(store.read(write()).byteLength).toBeGreaterThan(0);
  });

  it("refuses rollback if the inode matches but the device differs", () => {
    const target = join(root, "report.txt");
    db.function("different_device", () => {
      const stat = fs.lstatSync(target, { bigint: true });
      vi.spyOn(fs, "lstatSync").mockReturnValueOnce(Object.assign(stat, { dev: stat.dev + 1n }));
      return 1;
    });
    db.exec(
      "CREATE TRIGGER different_device BEFORE INSERT ON artifacts BEGIN SELECT different_device(); SELECT RAISE(ABORT, 'injected insert failure'); END",
    );
    expect(() => write()).toThrow("injected insert failure");
    expect(rowCount()).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("verified evidence\r\n");
  });

  it("never overwrites either an existing reference or a duplicate id", () => {
    const a = write();
    expect(() => write({ id: "another-id", bytes: Buffer.from("replacement") })).toThrow(
      new ArtifactError("ALREADY_EXISTS"),
    );
    expect(() => write({ path: "another.txt" })).toThrow(new ArtifactError("ALREADY_EXISTS"));
    expect(rowCount()).toBe(1);
    expect(Buffer.from(store.read(a)).toString()).toBe("verified evidence\r\n");
    expect(fs.existsSync(join(root, "another.txt"))).toBe(false);
  });

  it("refuses an outside writer racing publication and preserves its file", () => {
    const link = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementationOnce((from, to) => {
      // Interleave a real outside process after path validation, immediately before the link.
      const outside = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import fs from 'node:fs'; fs.writeFileSync(process.argv[1], 'outside writer evidence', {flag: 'wx'});",
          String(to),
        ],
        { timeout: 10_000 },
      );
      expect(outside.error).toBeUndefined();
      expect(outside.status).toBe(0);
      link(from, to);
    });
    expect(() => write()).toThrow(new ArtifactError("ALREADY_EXISTS"));
    expect(fs.readFileSync(join(root, "report.txt"), "utf8")).toBe("outside writer evidence");
    expect(fs.readdirSync(root)).toEqual(["report.txt"]);
    expect(rowCount()).toBe(0);
  });

  it("survives a DB restart", () => {
    const ref = write();
    db.close();
    db = openStateDatabase(join(directory, "state.db"));
    store = createLocalArtifactStore(root, db);
    expect(Buffer.from(store.read(ref)).toString()).toBe("verified evidence\r\n");
  });

  it("a killed writer before linking publishes no partial artifact or DB row", () => {
    // Real child process, file and SQLite transaction; no production fault hooks.
    const script = `
      import fs from 'node:fs';
      import { openStateDatabase } from './src/infrastructure/persistence/sqlite/sqlite-connection.ts';
      import { createLocalArtifactStore } from './src/infrastructure/artifacts/local-artifact-store.ts';
      const [root, database] = process.argv.slice(1);
      const db = openStateDatabase(database);
      fs.linkSync = () => process.kill(process.pid, 'SIGKILL');
      createLocalArtifactStore(root, db).write({ id: 'crashed', path: 'crashed.txt', bytes: Buffer.from('complete temp'), classification: 'report', createdAt: '${at}' });
    `;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "./tools/register-ts-imports.ts",
        "--input-type=module",
        "-e",
        script,
        root,
        join(directory, "state.db"),
      ],
      { cwd: resolve(import.meta.dirname, "../../.."), timeout: 10_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBe("SIGKILL");
    expect(fs.existsSync(join(root, "crashed.txt"))).toBe(false);
    expect(rowCount()).toBe(0);
    expect(fs.readdirSync(root)).toHaveLength(1);
    expect(fs.readdirSync(root)[0]).toMatch(/^\.artifact-.*\.tmp$/);
    expect(store.manifest([]).artifacts).toEqual([]);
    // A new publication after crash is not blocked by an abandoned temp file.
    write({ path: "crashed.txt" });
    expect(rowCount()).toBe(1);
  });
});

describe("untrusted artifact references", () => {
  it.each([
    "../escape",
    "nested/../escape",
    "/absolute",
    "C:escape",
    "C:/escape",
    "nested/C:escape",
    "\\escape",
    "nested\\escape",
    "nul" + String.fromCharCode(0),
    "",
    "./alias",
    "nested//alias",
    "nested/",
    "nested/\n/../escape",
  ])("rejects invalid path %j on write and read", (path) => {
    expect(() => write({ path })).toThrow(new ArtifactError("INVALID_PATH"));
    expect(() => store.read({ path, sha256: digest("") })).toThrow(
      new ArtifactError("INVALID_PATH"),
    );
    expect(rowCount()).toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each(["parent", "leaf", "dangling", "inward"])("rejects %s symlinks on write/read", (kind) => {
    const outside = join(directory, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, "file.txt"), "outside");
    const link = join(root, "link");
    let path = "link";
    if (kind === "parent") {
      fs.symlinkSync(outside, link);
      path = "link/file.txt";
    } else if (kind === "inward") {
      fs.writeFileSync(join(root, "inside.txt"), "inside");
      fs.symlinkSync(join(root, "inside.txt"), link);
    } else {
      fs.symlinkSync(join(outside, kind === "leaf" ? "file.txt" : "missing.txt"), link);
    }
    expect(() => write({ path })).toThrow(new ArtifactError("INVALID_PATH"));
    expect(() => store.read({ path, sha256: digest("outside") })).toThrow(
      new ArtifactError("INVALID_PATH"),
    );
    expect(fs.readFileSync(join(outside, "file.txt"), "utf8")).toBe("outside");
    expect(rowCount()).toBe(0);
  });

  it("rejects a symlink root and replacement of the root by a symlink", () => {
    const link = join(directory, "link");
    fs.symlinkSync(root, link);
    expect(() => createLocalArtifactStore(link, db)).toThrow(new ArtifactError("INVALID_PATH"));
    fs.renameSync(root, join(directory, "original"));
    fs.symlinkSync(join(directory, "original"), root);
    expect(() => write()).toThrow(new ArtifactError("INVALID_PATH"));
  });

  it("reports typed missing errors for absent DB entries, parent directories and removed files", () => {
    expect(() => store.read({ path: "missing.txt", sha256: digest("") })).toThrow(
      new ArtifactError("NOT_FOUND"),
    );
    expect(() => store.read({ path: "missing/file.txt", sha256: digest("") })).toThrow(
      new ArtifactError("NOT_FOUND"),
    );
    const ref = write();
    fs.unlinkSync(join(root, ref.path));
    expect(() => store.read(ref)).toThrow(new ArtifactError("NOT_FOUND"));
    expect(() => store.manifest([ref])).toThrow(new ArtifactError("NOT_FOUND"));
    fs.rmSync(root, { recursive: true });
    expect(() => store.read(ref)).toThrow(new ArtifactError("NOT_FOUND"));
  });

  it("rejects tampered bytes, a wrong pin, and a tampered DB hash", () => {
    const ref = write();
    expect(() => store.read({ ...ref, sha256: digest("wrong") })).toThrow(
      new ArtifactError("HASH_MISMATCH"),
    );
    fs.writeFileSync(join(root, ref.path), "tampered");
    expect(() => store.read(ref)).toThrow(new ArtifactError("HASH_MISMATCH"));
    expect(() => store.manifest([ref])).toThrow(new ArtifactError("HASH_MISMATCH"));
    fs.writeFileSync(join(root, ref.path), "verified evidence\r\n");
    db.prepare("UPDATE artifacts SET content_hash = ?").run(digest("tampered"));
    expect(() => store.read(ref)).toThrow(new ArtifactError("HASH_MISMATCH"));
  });

  it.each([
    { path: "profile/auth.json", text: "innocent" },
    { path: "report.txt", text: "Bearer synthetic-test-credential" },
    { path: "report.txt", text: '{"environment":{"PATH":"/synthetic/bin"}}' },
    { path: "report.txt", text: '{"accessToken":"synthetic"}' },
    { path: "report.txt", text: "Read CODEX_HOME/auth.json" },
  ])("rejects credential input before creating files or rows (%j)", ({ path, text }) => {
    expect(() => write({ path, bytes: Buffer.from(text) })).toThrow(CredentialInputError);
    expect(rowCount()).toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("honors configured environment values and nonstandard profile roots", () => {
    store = createLocalArtifactStore(root, db, {
      sensitiveValues: ["synthetic-environment-value"],
      credentialRoots: ["profiles/custom-login"],
    });
    expect(() => write({ bytes: Buffer.from("synthetic-environment-value") })).toThrow(
      CredentialInputError,
    );
    expect(() => write({ path: "profiles/custom-login/config.toml" })).toThrow(
      CredentialInputError,
    );
    expect(rowCount()).toBe(0);
  });
});

describe("adopt (worker-written files)", () => {
  const adopt = (path: string) =>
    store.adopt({
      id: "adopted-1",
      path,
      classification: "worker-output",
      createdAt: at,
    });

  it("hashes a file the worker wrote and makes it readable through the store", () => {
    fs.mkdirSync(join(root, "attempts"));
    fs.writeFileSync(join(root, "attempts", "analysis.md"), "findings");
    const reference = adopt("attempts/analysis.md");
    expect(reference).toEqual({ path: "attempts/analysis.md", sha256: digest("findings") });
    expect(new TextDecoder().decode(store.read(reference))).toBe("findings");
  });

  it("refuses a missing file and a symlink", () => {
    expect(() => adopt("nope.md")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    fs.writeFileSync(join(directory, "outside.txt"), "secret");
    fs.symlinkSync(join(directory, "outside.txt"), join(root, "link.md"));
    expect(() => adopt("link.md")).toThrow(ArtifactError);
  });

  const rows = () => (db.prepare("SELECT count(*) AS n FROM artifacts").get() as { n: number }).n;

  it("refuses credential-looking content and registers nothing", () => {
    fs.writeFileSync(join(root, "leak.md"), "Bearer synthetic-test-credential");
    expect(() => adopt("leak.md")).toThrow(CredentialInputError);
    expect(rows()).toBe(0);
  });

  it("refuses a directory and a FIFO instead of reading them", () => {
    fs.mkdirSync(join(root, "dir.md"));
    expect(() => adopt("dir.md")).toThrow(expect.objectContaining({ code: "INVALID_PATH" }));
    const made = spawnSync("mkfifo", [join(root, "pipe.md")]);
    expect(made.status).toBe(0);
    expect(() => adopt("pipe.md")).toThrow(expect.objectContaining({ code: "INVALID_PATH" }));
    expect(rows()).toBe(0);
  });

  it("refuses a file reached through a symlinked parent directory", () => {
    const outside = join(directory, "outside-dir");
    fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, "x.md"), "secret");
    fs.symlinkSync(outside, join(root, "linked"));
    expect(() => adopt("linked/x.md")).toThrow(ArtifactError);
    expect(rows()).toBe(0);
  });

  it("refuses a file that changed after it was first registered", () => {
    fs.writeFileSync(join(root, "a.md"), "one");
    adopt("a.md");
    fs.writeFileSync(join(root, "a.md"), "two");
    expect(() => adopt("a.md")).toThrow(expect.objectContaining({ code: "HASH_MISMATCH" }));
  });
});
