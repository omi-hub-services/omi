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
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCliWorkerCommitter } from "../../../src/infrastructure/git/cli-worker-committer.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
it("commits literal paths without executing a failing marker-writing hook", () => {
  const cwd = mkdtempSync(join(tmpdir(), "omi-worker-commit-"));
  temporary.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--initial-branch=task/omi-082-fixture");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/[literal].ts"), "fixture\n");
  writeFileSync(join(cwd, "src/l.ts"), "outside\n");
  const adapter = createCliWorkerCommitter();
  adapter.stage(cwd, ["src/[literal].ts"]);
  expect(adapter.stagedPaths(cwd)).toEqual(["src/[literal].ts"]);
  const hook = join(cwd, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho ran > hook-ran\nexit 1\n");
  chmodSync(hook, 0o700);
  expect(adapter.commit(cwd, "Implement fixture")).toBe(git("rev-parse", "HEAD"));
  expect(existsSync(join(cwd, "hook-ran"))).toBe(false);
  expect(git("show", "HEAD:src/[literal].ts")).toBe("fixture");
  expect(readFileSync(join(cwd, "src/l.ts"), "utf8")).toBe("outside\n");
});

it("unstages rejected credential additions without changing files or other index entries", () => {
  const cwd = mkdtempSync(join(tmpdir(), "omi-worker-unstage-"));
  temporary.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--initial-branch=task/omi-082-fixture");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "seed");
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/keep.ts"), "kept\n");
  writeFileSync(join(cwd, "src/.env"), "fixture only\n");
  const adapter = createCliWorkerCommitter();
  adapter.stage(cwd, ["src"]);
  expect(adapter.stagedPaths(cwd)).toEqual(["src/.env", "src/keep.ts"]);
  adapter.unstage(cwd, ["src/.env"]);
  expect(adapter.stagedPaths(cwd)).toEqual(["src/keep.ts"]);
  expect(readFileSync(join(cwd, "src/.env"), "utf8")).toBe("fixture only\n");
});
