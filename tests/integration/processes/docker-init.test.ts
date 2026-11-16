import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root = "";
let origin = "";
let seed = "";
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
const commit = (file: string): void => {
  writeFileSync(join(seed, file), file);
  git(seed, "add", file);
  git(seed, "commit", "-q", "-m", file);
  git(seed, "push", "-q", "origin", "develop");
};
const init = (branch: string) =>
  spawnSync(process.execPath, [resolve("templates/docker/init.mjs")], {
    input: JSON.stringify({
      repo: "demo",
      url: "https://github.com/acme/demo.git",
      gitUser: { name: "bot", email: "bot@example.com" },
      branch,
    }),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      OMI_WORK_ROOT: join(root, "work"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/acme/demo.git",
    },
  });
const checkout = () => join(root, "work/demo");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omi-init-"));
  origin = join(root, "origin.git");
  seed = join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, seed);
  writeFileSync(join(seed, "main.txt"), "main");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "main");
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(seed, "checkout", "-q", "-b", "develop");
  commit("one.txt");
  mkdirSync(join(root, "work"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("container init integration branch", () => {
  it("checks out the integration branch and fast-forwards it on a second run", () => {
    expect(init("develop").status).toBe(0);
    expect(git(checkout(), "branch", "--show-current")).toBe("develop");
    commit("two.txt");
    expect(init("develop").status).toBe(0);
    expect(git(checkout(), "rev-parse", "HEAD")).toBe(git(seed, "rev-parse", "HEAD"));
  });

  it("never resets a dirty or diverged checkout and names the branch", () => {
    expect(init("develop").status).toBe(0);
    writeFileSync(join(checkout(), "dirty.txt"), "x");
    commit("two.txt");
    const dirty = init("develop");
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain("develop");
    rmSync(join(checkout(), "dirty.txt"));
    writeFileSync(join(checkout(), "local.txt"), "x");
    git(checkout(), "add", "local.txt");
    git(checkout(), "commit", "-q", "-m", "local");
    const local = git(checkout(), "rev-parse", "HEAD");
    const diverged = init("develop");
    expect(diverged.status).not.toBe(0);
    expect(diverged.stderr).toContain("develop");
    expect(git(checkout(), "rev-parse", "HEAD")).toBe(local);
  });

  it("rejects an unsafe branch name", () => {
    expect(init("--upload-pack=x").status).not.toBe(0);
  });
});
