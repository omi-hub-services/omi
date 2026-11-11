import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitWorkspace,
  GitWorkspaceResult,
  TaskWorkspace,
  WorkspaceLeaseRequest,
} from "../../../src/application/ports/git-workspace.ts";
import { worktreeLeaseKey } from "../../../src/domain/runs/lease-resource.ts";
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
const T0 = "2026-11-11T00:00:00.000Z";
const T1 = "2026-11-11T00:01:00.000Z";
const T2 = "2026-11-11T00:02:00.000Z";
const T3 = "2026-11-11T00:03:00.000Z";
const REQUEST: WorkspaceLeaseRequest = {
  taskId: "omi-021",
  slug: "git-worktree-manager",
  owner: "runtime",
  now: T0,
  expiresAt: T2,
};

let directory: string;
let main: string;
let remote: string;
let dbPath: string;
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

function failure<T>(result: GitWorkspaceResult<T>, code: string): void {
  expect(result).toMatchObject({ ok: false, error: { code } });
}

function createTask(): TaskWorkspace {
  return value(workspace.createTask(REQUEST));
}

function commitTask(task: TaskWorkspace): string {
  writeFileSync(join(task.path, "task.txt"), "task work\n");
  git(task.path, "add", "task.txt");
  git(task.path, "commit", "-qm", "task work");
  return git(task.path, "rev-parse", "HEAD");
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omi-git-workspace-"));
  main = join(directory, "main checkout");
  remote = join(directory, "origin.git");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "develop");
  git(main, "config", "user.name", "Git workspace test");
  git(main, "config", "user.email", "git-workspace@example.invalid");
  writeFileSync(join(main, "tracked.txt"), "user work\n");
  writeFileSync(join(main, ".gitignore"), "ignored/\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "initial");
  git(directory, "init", "-q", "--bare", "-b", "develop", remote);
  git(main, "remote", "add", "origin", remote);
  // The only remote used by these tests is an OS-temp bare repository.
  git(main, "push", "-qu", "origin", "develop");
  dbPath = join(directory, "state.db");
  db = openStateDatabase(dbPath);
  applyMigrations(db, loadMigrations(join(SOURCE, "migrations")));
  workspace = createCliGitWorkspace({ mainWorktreePath: main }, createSqliteLeaseStore(db));
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("AC-1 task branch and sibling worktree", () => {
  it("reconciles a Git failure reported after successful creation", () => {
    const originalPath = process.env.PATH ?? "";
    const executable = originalPath
      .split(delimiter)
      .map((path) => join(path, "git"))
      .find(existsSync);
    if (executable === undefined) throw new Error("test requires Git on PATH");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!${process.execPath}
      const { spawnSync } = require("node:child_process");
      const args = process.argv.slice(2);
      const result = spawnSync(${JSON.stringify(executable)}, args, { stdio: "inherit" });
      const creating = args.includes("worktree") && args.includes("add");
      process.exit(creating && result.status === 0 ? 75 : result.status ?? 1);
    `,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}${delimiter}${originalPath}`);
    failure(workspace.createTask(REQUEST), "GIT_FAILED");
    vi.unstubAllEnvs();
    const task = createTask();
    expect(value(workspace.inspect(task.path))).toMatchObject({
      branch: task.branch,
      dirty: false,
    });
    expect(git(main, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
  });

  it("ignores ambient Git overrides that could redirect reads and writes", () => {
    const redirectedIndex = join(directory, "redirected-index");
    vi.stubEnv("GIT_INDEX_FILE", redirectedIndex);
    vi.stubEnv("GIT_DIR", remote);
    vi.stubEnv("GIT_WORK_TREE", directory);
    const task = createTask();
    expect(value(workspace.inspect(task.path))).toMatchObject({
      branch: task.branch,
      dirty: false,
    });
    expect(existsSync(redirectedIndex)).toBe(false);
  });

  it("creates at develop even when the user's checkout is on another branch", () => {
    const develop = git(main, "rev-parse", "develop");
    git(main, "switch", "-qc", "user-work");
    writeFileSync(join(main, "user.txt"), "user commit\n");
    git(main, "add", "user.txt");
    git(main, "commit", "-qm", "user commit");
    const task = createTask();

    expect(task.path).toBe(
      join(directory, "main checkout-worktrees", "omi-021-git-worktree-manager"),
    );
    expect(dirname(dirname(task.path))).toBe(dirname(main));
    expect(task.branch).toBe("task/omi-021-git-worktree-manager");
    expect(value(workspace.inspect(task.path))).toMatchObject({
      headSha: develop,
      branch: task.branch,
      dirty: false,
      hasIgnoredFiles: false,
    });
    expect(git(main, "branch", "--show-current")).toBe("user-work");
    expect(readFileSync(join(main, "user.txt"), "utf8")).toBe("user commit\n");
    expect(existsSync(join(task.path, "user.txt"))).toBe(false);
  });

  it("reconciles a creation retry, retaining edits and the existing HEAD", () => {
    const task = createTask();
    const head = commitTask(task);
    writeFileSync(join(task.path, "unfinished.txt"), "keep this\n");
    expect(value(workspace.createTask(REQUEST))).toEqual(task);
    expect(value(workspace.inspect(task.path))).toMatchObject({ headSha: head, dirty: true });
    expect(readFileSync(join(task.path, "unfinished.txt"), "utf8")).toBe("keep this\n");
    expect(git(main, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
  });

  it("creates independent task worktrees", () => {
    const first = createTask();
    const second = value(
      workspace.createTask({ ...REQUEST, taskId: "omi-022", slug: "prepare-pr" }),
    );
    expect(second.path).not.toBe(first.path);
    expect(git(first.path, "rev-parse", "HEAD")).toBe(git(second.path, "rev-parse", "HEAD"));
  });

  it.each([
    { taskId: "../omi-021", slug: "safe" },
    { taskId: "omi-021", slug: "../escape" },
    { taskId: "omi-021", slug: "--force" },
    { taskId: "omi-021", slug: "$(touch marker)" },
  ])("refuses invalid task identifiers before Git writes ($slug)", (id) => {
    failure(workspace.createTask({ ...REQUEST, ...id }), "INVALID_INPUT");
    expect(git(main, "branch", "--list", "task/*")).toBe("");
    expect(existsSync(join(directory, "main checkout-worktrees"))).toBe(false);
  });

  it("preserves a conflicting directory and a preexisting branch", () => {
    const root = join(directory, "main checkout-worktrees");
    const path = join(root, "omi-021-git-worktree-manager");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "user.txt"), "leave this\n");
    failure(workspace.createTask(REQUEST), "ALREADY_EXISTS");
    expect(readFileSync(join(path, "user.txt"), "utf8")).toBe("leave this\n");
    rmSync(path, { recursive: true });
    git(main, "branch", "task/omi-021-git-worktree-manager");
    failure(workspace.createTask(REQUEST), "ALREADY_EXISTS");
    expect(git(main, "rev-parse", "task/omi-021-git-worktree-manager")).toBe(
      git(main, "rev-parse", "develop"),
    );
  });

  it("supports configured sibling roots and rejects roots inside the checkout", () => {
    const configured = createCliGitWorkspace(
      { mainWorktreePath: main, worktreesRoot: join(directory, "tasks") },
      createSqliteLeaseStore(db),
    );
    expect(value(configured.createTask(REQUEST)).path).toBe(
      join(directory, "tasks", "omi-021-git-worktree-manager"),
    );
    expect(() =>
      createCliGitWorkspace(
        { mainWorktreePath: main, worktreesRoot: join(main, "nested") },
        createSqliteLeaseStore(db),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_PATH" }));
  });

  it("rejects symlink roots and task paths, preserving their targets", () => {
    const target = join(directory, "user-directory");
    mkdirSync(target);
    writeFileSync(join(target, "user.txt"), "private work\n");
    const root = join(directory, "main checkout-worktrees");
    symlinkSync(target, root);
    expect(() =>
      createCliGitWorkspace({ mainWorktreePath: main }, createSqliteLeaseStore(db)),
    ).toThrow(expect.objectContaining({ code: "INVALID_PATH" }));
    rmSync(root);
    mkdirSync(root);
    symlinkSync(target, join(root, "omi-021-git-worktree-manager"));
    failure(workspace.createTask(REQUEST), "INVALID_PATH");
    failure(workspace.removeTask(REQUEST), "INVALID_PATH");
    expect(readFileSync(join(target, "user.txt"), "utf8")).toBe("private work\n");
  });

  it("parses newline-bearing paths without shell or porcelain quoting", () => {
    const path = join(directory, 'checkout\nquoted"name');
    git(main, "worktree", "add", "-qb", "user-other", path, "develop");
    const adapter = createCliGitWorkspace({ mainWorktreePath: path }, createSqliteLeaseStore(db));
    const task = value(adapter.createTask(REQUEST));
    expect(value(adapter.inspect(task.path))).toMatchObject({ branch: task.branch, dirty: false });
  });
});

describe("AC-2 dirty user worktree", () => {
  it("detects dirty submodules and preserves their changes", () => {
    git(
      main,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      remote,
      "modules/dependency",
    );
    git(main, "commit", "-qam", "add dependency");
    const path = join(main, "modules", "dependency", "tracked.txt");
    writeFileSync(path, "user submodule edits\n");
    expect(value(workspace.inspect(main)).dirty).toBe(true);
    failure(workspace.createTask(REQUEST), "DIRTY_WORKTREE");
    expect(readFileSync(path, "utf8")).toBe("user submodule edits\n");
  });

  it.each(["--assume-unchanged", "--skip-worktree"])("accepts clean files carrying %s", (flag) => {
    git(main, "update-index", flag, "tracked.txt");
    const before = readFileSync(join(main, ".git", "index"));
    expect(value(workspace.inspect(main)).dirty).toBe(false);
    expect(workspace.createTask(REQUEST).ok).toBe(true);
    expect(readFileSync(join(main, ".git", "index"))).toEqual(before);
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "detects edits hidden by %s without modifying the user's index",
    (flag) => {
      git(main, "update-index", flag, "tracked.txt");
      const before = readFileSync(join(main, ".git", "index"));
      writeFileSync(join(main, "tracked.txt"), "hidden user edits\n");
      expect(git(main, "status", "--porcelain")).toBe("");
      expect(value(workspace.inspect(main)).dirty).toBe(true);
      failure(workspace.createTask(REQUEST), "DIRTY_WORKTREE");
      expect(readFileSync(join(main, ".git", "index"))).toEqual(before);
      expect(readFileSync(join(main, "tracked.txt"), "utf8")).toBe("hidden user edits\n");
    },
  );

  it("handles an index with split-index storage and concealed edits", () => {
    git(main, "update-index", "--split-index");
    git(main, "update-index", "--assume-unchanged", "tracked.txt");
    writeFileSync(join(main, "tracked.txt"), "hidden split-index edits\n");
    failure(workspace.createTask(REQUEST), "DIRTY_WORKTREE");
    expect(readFileSync(join(main, "tracked.txt"), "utf8")).toBe("hidden split-index edits\n");
  });

  it("keeps absent sparse-checkout entries clean", () => {
    git(main, "update-index", "--skip-worktree", "tracked.txt");
    rmSync(join(main, "tracked.txt"));
    expect(value(workspace.inspect(main)).dirty).toBe(false);
    expect(workspace.createTask(REQUEST).ok).toBe(true);
  });

  it.each(["unstaged", "staged", "untracked", "deleted", "renamed"])(
    "refuses %s user work and preserves it",
    (kind) => {
      if (kind === "untracked") writeFileSync(join(main, "user notes\n.txt"), "notes\n");
      else if (kind === "deleted") rmSync(join(main, "tracked.txt"));
      else if (kind === "renamed") git(main, "mv", "tracked.txt", "renamed.txt");
      else {
        writeFileSync(join(main, "tracked.txt"), "edited\n");
        if (kind === "staged") git(main, "add", "tracked.txt");
      }
      const before = git(main, "status", "--porcelain=v1", "-z");
      const head = git(main, "rev-parse", "HEAD");
      expect(value(workspace.inspect(main)).dirty).toBe(true);
      failure(workspace.createTask(REQUEST), "DIRTY_WORKTREE");
      expect(git(main, "status", "--porcelain=v1", "-z")).toBe(before);
      expect(git(main, "rev-parse", "HEAD")).toBe(head);
      expect(git(main, "branch", "--list", "task/*")).toBe("");
    },
  );

  it("reports ignored files separately so installed dependencies allow task creation", () => {
    mkdirSync(join(main, "ignored"));
    writeFileSync(join(main, "ignored", "dependency.txt"), "ignored\n");
    expect(value(workspace.inspect(main))).toMatchObject({ dirty: false, hasIgnoredFiles: true });
    expect(workspace.createTask(REQUEST).ok).toBe(true);
    expect(readFileSync(join(main, "ignored", "dependency.txt"), "utf8")).toBe("ignored\n");
  });

  it("refuses a path outside the repository's worktree registrations", () => {
    failure(workspace.inspect(directory), "NOT_FOUND");
    failure(workspace.inspect(join(main, "tracked.txt")), "NOT_FOUND");
  });
});

describe("AC-3 one writer per canonical worktree", () => {
  it("blocks nested and competing writers across independent connections and path aliases", () => {
    const task = createTask();
    const lease = value(workspace.acquireWriter(REQUEST));
    expect(lease.resourceKey).toBe(worktreeLeaseKey(task.path));
    failure(workspace.acquireWriter(REQUEST), "WRITER_HELD");
    const alias = join(directory, "checkout-alias");
    symlinkSync(main, alias);
    const otherDb = openStateDatabase(dbPath);
    try {
      const other = createCliGitWorkspace(
        { mainWorktreePath: alias },
        createSqliteLeaseStore(otherDb),
      );
      failure(other.acquireWriter({ ...REQUEST, owner: "nested" }), "WRITER_HELD");
      failure(other.createTask({ ...REQUEST, owner: "nested" }), "WRITER_HELD");
      failure(other.removeTask({ ...REQUEST, owner: "cleanup" }), "WRITER_HELD");
    } finally {
      otherDb.close();
    }
    expect(existsSync(task.path)).toBe(true);
  });

  it("keeps expired writer reservations until explicit fenced release", () => {
    createTask();
    const lease = value(workspace.acquireWriter({ ...REQUEST, expiresAt: T1 }));
    failure(
      workspace.acquireWriter({ ...REQUEST, owner: "replacement", now: T2, expiresAt: T3 }),
      "WRITER_HELD",
    );
    failure(workspace.removeTask({ ...REQUEST, now: T2, expiresAt: T3 }), "WRITER_HELD");
    failure(
      workspace.renewWriter({ ...REQUEST, generation: lease.generation, now: T2, expiresAt: T3 }),
      "LEASE_EXPIRED",
    );
    expect(
      workspace.releaseWriter({
        taskId: REQUEST.taskId,
        slug: REQUEST.slug,
        owner: REQUEST.owner,
        generation: lease.generation,
        now: T2,
      }).ok,
    ).toBe(true);
    const next = value(
      workspace.acquireWriter({ ...REQUEST, owner: "replacement", now: T2, expiresAt: T3 }),
    );
    expect(next.generation).toBeGreaterThan(lease.generation);
    failure(
      workspace.releaseWriter({
        taskId: REQUEST.taskId,
        slug: REQUEST.slug,
        owner: REQUEST.owner,
        generation: lease.generation,
        now: T2,
      }),
      "STALE_LEASE",
    );
    failure(workspace.acquireWriter({ ...REQUEST, now: T2, expiresAt: T3 }), "WRITER_HELD");
  });

  it("renews a live writer and allows independent writers on different tasks", () => {
    createTask();
    value(workspace.createTask({ ...REQUEST, taskId: "omi-022", slug: "prepare-pr" }));
    const lease = value(workspace.acquireWriter(REQUEST));
    expect(
      value(
        workspace.renewWriter({ ...REQUEST, generation: lease.generation, now: T1, expiresAt: T3 }),
      ).expiresAt,
    ).toBe(T3);
    expect(workspace.acquireWriter({ ...REQUEST, taskId: "omi-022", slug: "prepare-pr" }).ok).toBe(
      true,
    );
  });

  it("releases an unsuccessful acquisition so retries do not strand a reservation", () => {
    failure(workspace.acquireWriter(REQUEST), "NOT_FOUND");
    expect(workspace.createTask(REQUEST).ok).toBe(true);
    expect(workspace.acquireWriter(REQUEST).ok).toBe(true);
  });

  it("admits exactly one writer when separate processes race", async () => {
    createTask();
    const script = `
      import { createCliGitWorkspace } from ${JSON.stringify(pathToFileURL(join(SOURCE, "src/infrastructure/git/cli-git-workspace.ts")).href)};
      import { openStateDatabase } from ${JSON.stringify(pathToFileURL(join(SOURCE, "src/infrastructure/persistence/sqlite/sqlite-connection.ts")).href)};
      import { createSqliteLeaseStore } from ${JSON.stringify(pathToFileURL(join(SOURCE, "src/infrastructure/persistence/sqlite/sqlite-lease-store.ts")).href)};
      const [main, dbPath, owner] = process.argv.slice(1);
      const db = openStateDatabase(dbPath);
      const adapter = createCliGitWorkspace({ mainWorktreePath: main }, createSqliteLeaseStore(db));
      const result = adapter.acquireWriter({ ...${JSON.stringify(REQUEST)}, owner });
      process.stdout.write(JSON.stringify(result.ok ? { ok: true } : { ok: false, code: result.error.code }));
      db.close();
    `;
    const run = promisify(execFile);
    const outputs = await Promise.all(
      ["process-a", "process-b"].map((owner) =>
        run(
          process.execPath,
          [
            "--import",
            join(SOURCE, "tools/register-ts-imports.ts"),
            "--input-type=module",
            "-e",
            script,
            main,
            dbPath,
            owner,
          ],
          { cwd: directory, timeout: 10_000 },
        ),
      ),
    );
    expect(outputs.map((output) => output.stdout).sort()).toEqual(
      ['{"ok":false,"code":"WRITER_HELD"}', '{"ok":true}'].sort(),
    );
  });
});

describe("AC-4 lossless cleanup", () => {
  it("preserves ignored data in initialized submodules when Git refuses removal", () => {
    git(
      main,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      remote,
      "modules/dependency",
    );
    git(main, "commit", "-qam", "add dependency");
    git(main, "push", "-q", "origin", "develop");
    const task = createTask();
    git(task.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--quiet");
    const ignored = join(task.path, "modules", "dependency", "ignored");
    mkdirSync(ignored);
    writeFileSync(join(ignored, "user.txt"), "submodule data\n");
    failure(workspace.removeTask(REQUEST), "GIT_FAILED");
    expect(readFileSync(join(ignored, "user.txt"), "utf8")).toBe("submodule data\n");
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "preserves task edits hidden by %s",
    (flag) => {
      const task = createTask();
      git(task.path, "update-index", flag, "tracked.txt");
      const indexPath = git(
        task.path,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      );
      const index = readFileSync(indexPath);
      writeFileSync(join(task.path, "tracked.txt"), "hidden task edits\n");
      expect(git(task.path, "status", "--porcelain")).toBe("");
      failure(workspace.removeTask(REQUEST), "DIRTY_WORKTREE");
      expect(readFileSync(join(task.path, "tracked.txt"), "utf8")).toBe("hidden task edits\n");
      expect(readFileSync(indexPath)).toEqual(index);
    },
  );

  it.each(["unstaged", "staged", "untracked", "ignored"])(
    "refuses %s task files and preserves their bytes",
    (kind) => {
      const task = createTask();
      let path = join(task.path, "tracked.txt");
      if (kind === "untracked") path = join(task.path, "unfinished.txt");
      if (kind === "ignored") {
        mkdirSync(join(task.path, "ignored"));
        path = join(task.path, "ignored", "user.txt");
      }
      writeFileSync(path, "unfinished work\n");
      if (kind === "staged") git(task.path, "add", "tracked.txt");
      const status = git(task.path, "status", "--porcelain=v1", "--ignored");
      failure(workspace.removeTask(REQUEST), "DIRTY_WORKTREE");
      expect(readFileSync(path, "utf8")).toBe("unfinished work\n");
      expect(git(task.path, "status", "--porcelain=v1", "--ignored")).toBe(status);
    },
  );

  it("preserves clean commits that have not merged, even after pushing the task branch", () => {
    const task = createTask();
    const head = commitTask(task);
    git(task.path, "push", "-qu", "origin", task.branch);
    failure(workspace.removeTask(REQUEST), "UNMERGED_WORK");
    expect(git(task.path, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(task.path, "task.txt"), "utf8")).toBe("task work\n");
  });

  it("preserves commits merged only locally until the integration branch is pushed", () => {
    const task = createTask();
    const head = commitTask(task);
    git(main, "merge", "--ff-only", task.branch);
    failure(workspace.removeTask(REQUEST), "UNPUSHED_WORK");
    expect(git(task.path, "rev-parse", "HEAD")).toBe(head);
    git(main, "push", "-q", "origin", "develop");
    expect(workspace.removeTask(REQUEST).ok).toBe(true);
    expect(existsSync(task.path)).toBe(false);
    expect(git(main, "rev-parse", `refs/heads/${task.branch}`)).toBe(head);
    expect(workspace.removeTask(REQUEST).ok).toBe(true);
    expect(readFileSync(join(main, "tracked.txt"), "utf8")).toBe("user work\n");
  });

  it("refuses cleanup when remote-tracking evidence is missing", () => {
    const task = createTask();
    git(main, "update-ref", "-d", "refs/remotes/origin/develop");
    failure(workspace.removeTask(REQUEST), "UNPUSHED_WORK");
    expect(existsSync(task.path)).toBe(true);
  });

  it("preserves detached, switched and externally locked task worktrees", () => {
    const task = createTask();
    git(task.path, "switch", "--detach", "-q");
    failure(workspace.removeTask(REQUEST), "ALREADY_EXISTS");
    git(task.path, "switch", "-q", task.branch);
    git(main, "worktree", "lock", "--reason", "user work", task.path);
    failure(workspace.removeTask(REQUEST), "ALREADY_EXISTS");
    expect(existsSync(task.path)).toBe(true);
    git(main, "worktree", "unlock", task.path);
    git(task.path, "switch", "-qc", "user-task-branch");
    failure(workspace.removeTask(REQUEST), "ALREADY_EXISTS");
  });

  it("refuses a missing directory with a remaining registration", () => {
    const task = createTask();
    rmSync(task.path, { recursive: true });
    failure(workspace.removeTask(REQUEST), "ALREADY_EXISTS");
    expect(git(main, "worktree", "list", "--porcelain")).toContain(task.branch);
    expect(git(main, "rev-parse", task.branch)).toBe(git(main, "rev-parse", "develop"));
  });

  it("allows cleanup alongside dirty main-checkout files while preserving those files", () => {
    const task = createTask();
    writeFileSync(join(main, "tracked.txt"), "PO edits\n");
    expect(workspace.removeTask(REQUEST).ok).toBe(true);
    expect(existsSync(task.path)).toBe(false);
    expect(readFileSync(join(main, "tracked.txt"), "utf8")).toBe("PO edits\n");
  });
});
