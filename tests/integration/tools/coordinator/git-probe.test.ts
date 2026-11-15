import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localGit, probeBranch, wslGit } from "../../../../tools/coordinator/git-probe.ts";
import { createProcessRunner } from "../../../../tools/coordinator/process-runner.ts";

// The WSL path (bash -lc, as used inside Linux) and the host path (plain argv) must read the
// same state from a real repository.
const BRANCH = "task/omi-051-x";
let dir = "";
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
    cwd: dir,
    encoding: "utf8",
  });

async function probe() {
  const run = createProcessRunner();
  const viaBash = await probeBranch(
    run,
    wslGit({ viaWslExe: false, distro: "-", repoDir: dir }),
    BRANCH,
  );
  expect(await probeBranch(run, localGit(dir), BRANCH)).toEqual(viaBash);
  return viaBash;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-git-probe-"));
  git("init", "-q", "-b", "develop");
  writeFileSync(join(dir, "f.txt"), "a\n");
  git("add", "f.txt");
  git("commit", "-q", "-m", "init");
  git("update-ref", "refs/remotes/origin/develop", "HEAD");
  git("switch", "-q", "-c", BRANCH);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("probeBranch on a real checkout", () => {
  it("reads a clean checkout on a branch merged into origin/develop", async () => {
    expect(await probe()).toMatchObject({
      current: BRANCH,
      dirty: false,
      clean: true,
      merged: true,
    });
  });

  it("sees an unstaged edit of a tracked file (porcelain ' M') as dirty", async () => {
    writeFileSync(join(dir, "f.txt"), "b\n");
    expect(await probe()).toMatchObject({ dirty: true, clean: false });
    git("restore", "f.txt");
  });

  it("sees an untracked file as not clean but not dirty", async () => {
    writeFileSync(join(dir, "new.txt"), "x\n");
    expect(await probe()).toMatchObject({ dirty: false, clean: false });
    rmSync(join(dir, "new.txt"));
  });

  it("reports a branch with its own commits as not merged, and a missing branch as absent", async () => {
    writeFileSync(join(dir, "g.txt"), "g\n");
    git("add", "g.txt");
    git("commit", "-q", "-m", "work");
    expect(await probe()).toMatchObject({ merged: false, clean: true });
    git("switch", "-q", "develop");
    git("branch", "-q", "-D", BRANCH);
    expect(await probe()).toMatchObject({ current: "develop", local: null, merged: false });
  });
});
