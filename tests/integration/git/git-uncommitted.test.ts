import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uncommittedManifestSchema } from "../../../src/application/contracts/checkpoint.ts";
import type {
  GitWorkspace,
  GitWorkspaceResult,
} from "../../../src/application/ports/git-workspace.ts";
import { createCliGitWorkspace } from "../../../src/infrastructure/git/cli-git-workspace.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteLeaseStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";

const SOURCE = resolve(import.meta.dirname, "../../..");
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

let directory: string;
let main: string;
let db: StateDatabase;
let workspace: GitWorkspace;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trimEnd();
}

function value<T>(result: GitWorkspaceResult<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omi-uncommitted-"));
  main = join(directory, "main checkout");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "develop");
  git(main, "config", "user.name", "Checkpoint test");
  git(main, "config", "user.email", "checkpoint@example.invalid");
  writeFileSync(join(main, "tracked.txt"), "one\n");
  writeFileSync(join(main, "staged.txt"), "old\n");
  writeFileSync(join(main, "gone.txt"), "bye\n");
  writeFileSync(join(main, ".gitignore"), "ignored/\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "initial");
  db = openStateDatabase(join(directory, "state.db"));
  applyMigrations(db, loadMigrations(join(SOURCE, "migrations")));
  workspace = createCliGitWorkspace({ mainWorktreePath: main }, createSqliteLeaseStore(db));
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("listUncommitted", () => {
  it("is empty for a clean worktree", () => {
    expect(value(workspace.listUncommitted(main))).toEqual({
      entries: [],
      truncated: false,
      excludedCredentialPaths: 0,
    });
  });

  it("lists staged, unstaged, deleted and untracked files with content hashes, and changes nothing", () => {
    writeFileSync(join(main, "tracked.txt"), "two\n");
    writeFileSync(join(main, "staged.txt"), "new\n");
    git(main, "add", "staged.txt");
    git(main, "rm", "-q", "--cached", "gone.txt");
    writeFileSync(join(main, "gone.txt"), "bye\n");
    rmSync(join(main, "gone.txt"));
    mkdirSync(join(main, "sub dir"));
    writeFileSync(join(main, "sub dir", "new file.txt"), "fresh\n");
    mkdirSync(join(main, "ignored"));
    writeFileSync(join(main, "ignored", "x"), "ignored\n");
    const before = git(main, "status", "--porcelain=v1", "--ignored");

    const manifest = value(workspace.listUncommitted(main));

    expect(uncommittedManifestSchema.safeParse(manifest).success).toBe(true);
    const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("tracked.txt")).toEqual({
      path: "tracked.txt",
      status: "modified",
      staged: false,
      sha256: digest("two\n"),
      size: 4,
    });
    expect(byPath.get("staged.txt")).toMatchObject({
      status: "modified",
      staged: true,
      sha256: digest("new\n"),
    });
    expect(byPath.get("gone.txt")).toMatchObject({ status: "deleted", sha256: null, size: null });
    expect(byPath.get("sub dir/new file.txt")).toEqual({
      path: "sub dir/new file.txt",
      status: "untracked",
      staged: false,
      sha256: digest("fresh\n"),
      size: 6,
    });
    expect(byPath.has("ignored/x")).toBe(false);
    expect(git(main, "status", "--porcelain=v1", "--ignored")).toBe(before);
  });

  it("never lists or hashes a credential-looking path, it only counts it", () => {
    writeFileSync(join(main, ".env"), "API_TOKEN=abc123abc123\n");
    writeFileSync(join(main, "auth.json"), "{}\n");
    writeFileSync(join(main, "notes.txt"), "ok\n");

    const manifest = value(workspace.listUncommitted(main));

    expect(manifest.entries.map((entry) => entry.path)).toEqual(["notes.txt"]);
    expect(manifest.excludedCredentialPaths).toBe(2);
    expect(JSON.stringify(manifest)).not.toContain(digest("API_TOKEN=abc123abc123\n"));
  });

  it("bounds the manifest: entry count and per-file hashing", () => {
    for (const name of ["a", "b", "c"]) writeFileSync(join(main, `${name}.txt`), `${name}\n`);
    writeFileSync(join(main, "big.bin"), Buffer.alloc(64));

    const limited = value(workspace.listUncommitted(main, { maxEntries: 2 }));
    expect(limited.entries).toHaveLength(2);
    expect(limited.truncated).toBe(true);

    const sized = value(workspace.listUncommitted(main, { maxFileBytes: 10 }));
    expect(sized.entries.find((entry) => entry.path === "big.bin")).toMatchObject({
      sha256: null,
      size: 64,
    });
    expect(sized.truncated).toBe(false);
  });

  it("does not follow a symlink: it is listed without a hash", () => {
    writeFileSync(join(directory, "outside.txt"), "outside\n");
    symlinkSync(join(directory, "outside.txt"), join(main, "link.txt"));
    const entry = value(workspace.listUncommitted(main)).entries.find((e) => e.path === "link.txt");
    expect(entry).toMatchObject({ status: "untracked", sha256: null, size: null });
  });

  it("refuses a path that is not a registered worktree", () => {
    expect(workspace.listUncommitted(directory)).toMatchObject({ ok: false });
    expect(workspace.listUncommitted("relative")).toMatchObject({
      ok: false,
      error: { code: "INVALID_PATH" },
    });
  });
});
