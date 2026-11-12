import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { commitWorker } from "../../../src/application/use-cases/runs/commit-worker.ts";
import { dispatchStep } from "../../../src/application/use-cases/runs/dispatch-step.ts";
import { createCliGitWorkspace } from "../../../src/infrastructure/git/cli-git-workspace.ts";
import { createCliWorkerCommitter } from "../../../src/infrastructure/git/cli-worker-committer.ts";
import { createSqliteLeaseStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-lease-store.ts";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { dispatchInput, rig } from "../../unit/application/use-cases/runs/run-fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(hook?: string) {
  const dir = mkdtempSync(join(tmpdir(), "omi-commit-worker-"));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const main = join(dir, "project");
  const template = join(dir, "empty-template");
  mkdirSync(main);
  mkdirSync(template);
  const gitAt = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  gitAt(main, "init", `--template=${template}`, "--initial-branch=develop");
  gitAt(main, "config", "user.name", "Fixture");
  gitAt(main, "config", "user.email", "fixture@example.invalid");
  mkdirSync(join(main, "src"));
  writeFileSync(join(main, "src/file.ts"), "before\n");
  if (hook !== undefined) {
    gitAt(main, "config", "core.hooksPath", ".husky");
    mkdirSync(join(main, ".husky"));
    writeFileSync(join(main, ".husky/pre-commit"), hook);
    chmodSync(join(main, ".husky/pre-commit"), 0o700);
  }
  gitAt(main, "add", ".");
  gitAt(main, "-c", "core.hooksPath=/dev/null", "commit", "-m", "seed");
  const db = openStateDatabase(join(dir, "state.sqlite"));
  cleanups.unshift(() => db.close());
  applyMigrations(db, loadMigrations(resolve("migrations")));
  const workspaces = createCliGitWorkspace(
    { mainWorktreePath: main, worktreesRoot: join(dir, "worktrees") },
    createSqliteLeaseStore(db),
  );
  const r = rig();
  const now = new Date(r.deps.now()).toISOString();
  const expiresAt = new Date(r.deps.now() + 120_000).toISOString();
  const workspace = workspaces.createTask({
    taskId: "omi-082",
    slug: "review",
    owner: "setup",
    now,
    expiresAt,
  });
  if (!workspace.ok) throw workspace.error;
  const dispatched = await dispatchStep(r.deps, dispatchInput());
  if (!dispatched.ok) throw new Error(dispatched.reason);
  r.attempts.rows.set(dispatched.attempt.id, {
    ...dispatched.attempt,
    status: "failed",
    workspace: { ...dispatched.attempt.workspace, ...workspace.value },
  });
  writeFileSync(join(workspace.value.path, "src/file.ts"), "after\n");
  const git = (...args: string[]) => gitAt(workspace.value.path, ...args);
  const base = git("rev-parse", "HEAD");
  const deps = { ...r.deps, workspaces, committer: createCliWorkerCommitter() };
  return {
    cwd: workspace.value.path,
    git,
    base,
    run: () => commitWorker(deps, { attemptId: dispatched.attempt.id, message: "Implement task" }),
  };
}

it("commits a stopped worker through real workspace leases and Git committer", async () => {
  const s = await setup();
  const result = s.run();
  expect(result).toMatchObject({ ok: true, headSha: s.git("rev-parse", "HEAD") });
  expect(s.git("rev-parse", "HEAD")).not.toBe(s.base);
  expect(s.run()).toEqual({ ok: false, reason: "NOTHING_TO_COMMIT" });
});

it.each(["modified", "staged", "untracked"] as const)(
  "refuses %s files under the effective hooks path",
  async (kind) => {
    const s = await setup("#!/bin/sh\nexit 0\n");
    const path = kind === "untracked" ? ".husky/extra" : ".husky/pre-commit";
    writeFileSync(join(s.cwd, path), "#!/bin/sh\nexit 1\n");
    if (kind === "staged") s.git("add", "--", path);
    expect(s.run()).toEqual({ ok: false, reason: "UNTRUSTED_HOOKS" });
    expect(s.git("rev-parse", "HEAD")).toBe(s.base);
    expect(s.git("diff", "--cached", "--name-only")).not.toContain("src/file.ts");
  },
);

it("refuses untracked default .git/hooks scripts", async () => {
  const s = await setup();
  const hooks = resolve(s.cwd, s.git("rev-parse", "--git-path", "hooks"));
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n");
  expect(s.run()).toEqual({ ok: false, reason: "UNTRUSTED_HOOKS" });
});

it("undoes a hook's out-of-scope commit and preserves worktree files", async () => {
  const s = await setup("#!/bin/sh\ngit add -- outside.txt\n");
  writeFileSync(join(s.cwd, "outside.txt"), "outside\n");
  expect(s.run()).toEqual({ ok: false, reason: "UNSAFE_COMMIT" });
  expect(s.git("rev-parse", "HEAD")).toBe(s.base);
  expect(s.git("diff", "--cached", "--name-only")).toBe("");
  expect(readFileSync(join(s.cwd, "src/file.ts"), "utf8")).toBe("after\n");
  expect(readFileSync(join(s.cwd, "outside.txt"), "utf8")).toBe("outside\n");
});
