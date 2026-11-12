import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

async function setup(hook?: string, delegatedScript?: string) {
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
  if (delegatedScript !== undefined) {
    mkdirSync(join(main, "scripts"));
    writeFileSync(join(main, "scripts/hook-body.sh"), delegatedScript);
  }
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
    deps,
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

it("does not execute default hooks or commit outside files", async () => {
  const s = await setup();
  const hooks = resolve(s.cwd, s.git("rev-parse", "--git-path", "hooks"));
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    join(hooks, "pre-commit"),
    "#!/bin/sh\necho ran > hook-ran\ngit add -- outside.txt\nexit 1\n",
  );
  chmodSync(join(hooks, "pre-commit"), 0o700);
  writeFileSync(join(s.cwd, "outside.txt"), "outside\n");
  expect(s.run()).toMatchObject({ ok: true });
  expect(existsSync(join(s.cwd, "hook-ran"))).toBe(false);
  expect(s.git("diff", "--name-only", s.base, "HEAD")).toBe("src/file.ts");
  expect(readFileSync(join(s.cwd, "outside.txt"), "utf8")).toBe("outside\n");
});

it("does not execute configured hooks or commit outside files", async () => {
  const s = await setup("#!/bin/sh\necho ran > hook-ran\ngit add -- outside.txt\nexit 1\n");
  writeFileSync(join(s.cwd, "outside.txt"), "outside\n");
  expect(s.run()).toMatchObject({ ok: true });
  expect(existsSync(join(s.cwd, "hook-ran"))).toBe(false);
  expect(s.git("diff", "--name-only", s.base, "HEAD")).toBe("src/file.ts");
  expect(readFileSync(join(s.cwd, "outside.txt"), "utf8")).toBe("outside\n");
});

it("does not execute an unchanged hook delegating to a worker-modified script", async () => {
  const s = await setup("#!/bin/sh\nsh scripts/hook-body.sh\n", "#!/bin/sh\nexit 0\n");
  const changed = "#!/bin/sh\necho ran > hook-ran\ngit add -- outside.txt\nexit 1\n";
  writeFileSync(join(s.cwd, "scripts/hook-body.sh"), changed);
  writeFileSync(join(s.cwd, "outside.txt"), "outside\n");
  expect(s.run()).toMatchObject({ ok: true });
  expect(existsSync(join(s.cwd, "hook-ran"))).toBe(false);
  expect(s.git("diff", "--name-only", s.base, "HEAD")).toBe("src/file.ts");
  expect(readFileSync(join(s.cwd, "scripts/hook-body.sh"), "utf8")).toBe(changed);
  expect(readFileSync(join(s.cwd, "outside.txt"), "utf8")).toBe("outside\n");
});

it("refuses an already-staged outside path with hooks configured", async () => {
  const s = await setup("#!/bin/sh\necho ran > hook-ran\n");
  writeFileSync(join(s.cwd, "outside.txt"), "outside\n");
  s.git("add", "outside.txt");
  expect(s.run()).toEqual({ ok: false, reason: "UNSAFE_INDEX" });
  expect(s.git("rev-parse", "HEAD")).toBe(s.base);
  expect(existsSync(join(s.cwd, "hook-ran"))).toBe(false);
  expect(readFileSync(join(s.cwd, "outside.txt"), "utf8")).toBe("outside\n");
});

it("recovers a real commit followed by a command error while preserving files", async () => {
  const s = await setup();
  writeFileSync(join(s.cwd, "outside.txt"), "outside\n");
  const commit = s.deps.committer.commit.bind(s.deps.committer);
  const original = new Error("COMMIT_ACK_FAILED");
  s.deps.committer.commit = (cwd, message) => {
    commit(cwd, message);
    throw original;
  };
  expect(s.run).toThrow(original);
  expect(s.git("rev-parse", "HEAD")).toBe(s.base);
  expect(s.git("diff", "--cached", "--name-only")).toBe("");
  expect(readFileSync(join(s.cwd, "src/file.ts"), "utf8")).toBe("after\n");
  expect(readFileSync(join(s.cwd, "outside.txt"), "utf8")).toBe("outside\n");
  s.deps.committer.commit = commit;
  expect(s.run()).toMatchObject({ ok: true });
});
