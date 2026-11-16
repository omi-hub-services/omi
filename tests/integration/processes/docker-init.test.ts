import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root = "";
let origin = "";
let seed = "";
let fakeNpm = "";
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
const init = (branch: string, extraEnv: Record<string, string> = {}) =>
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
      OMI_NPM: fakeNpm,
      ...extraEnv,
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
  fakeNpm = join(root, "fake-npm.sh");
  writeFileSync(
    fakeNpm,
    `#!/bin/sh\necho "$@" >> "${join(root, "npm.log")}"\nmkdir -p node_modules\nexit \${FAKE_NPM_EXIT:-0}\n`,
    { mode: 0o755 },
  );
  // Init requires the project runtime on the branch; every test starts with one committed.
  mkdirSync(join(seed, ".omi/tool"), { recursive: true });
  writeFileSync(join(seed, ".omi/tool/package.json"), "{}");
  writeFileSync(join(seed, ".omi/tool/package-lock.json"), "lock-0");
  writeFileSync(join(seed, ".gitignore"), "node_modules/\n");
  git(seed, "add", ".gitignore");
  git(seed, "add", "-f", ".omi/tool");
  git(seed, "commit", "-q", "-m", "tool");
  git(seed, "push", "-q", "origin", "develop");
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

  describe(".omi/tool runtime install", () => {
    let log = "";
    let npmEnv: Record<string, string> = {};
    const installs = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").length - 1 : 0);
    const commitTool = (lock: string): void => {
      writeFileSync(join(seed, ".omi/tool/package-lock.json"), lock);
      git(seed, "add", "-f", ".omi/tool");
      git(seed, "commit", "-q", "-m", "tool");
      git(seed, "push", "-q", "origin", "develop");
    };
    beforeEach(() => {
      log = join(root, "npm.log");
      npmEnv = {};
    });

    it("installs when node_modules is missing, skips on an unchanged lock, reinstalls on change", () => {
      commitTool("lock-1");
      expect(init("develop", npmEnv).status).toBe(0);
      expect(installs()).toBe(1);
      expect(readFileSync(log, "utf8")).toContain("ci --no-audit --no-fund");
      expect(init("develop", npmEnv).status).toBe(0);
      expect(installs()).toBe(1);
      commitTool("lock-2");
      expect(init("develop", npmEnv).status).toBe(0);
      expect(installs()).toBe(2);
    });

    it("exits non-zero naming package-lock.json when the lock is missing", () => {
      git(seed, "rm", "-q", ".omi/tool/package-lock.json");
      git(seed, "commit", "-q", "-m", "nolock");
      git(seed, "push", "-q", "origin", "develop");
      const result = init("develop", npmEnv);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("package-lock.json");
      expect(result.stderr).not.toContain("ENOENT");
    });

    it("exits non-zero with a clear message when the install fails or package.json is absent", () => {
      commitTool("lock-1");
      const failed = init("develop", { ...npmEnv, FAKE_NPM_EXIT: "1" });
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain(".omi/tool");
      git(seed, "rm", "-q", ".omi/tool/package.json");
      git(seed, "commit", "-q", "-m", "drop");
      git(seed, "push", "-q", "origin", "develop");
      const missing = init("develop", npmEnv);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("package.json");
    });
  });

  it("rejects an unsafe branch name", () => {
    expect(init("--upload-pack=x").status).not.toBe(0);
  });
});
