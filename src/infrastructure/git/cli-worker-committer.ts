import type { WorkerCommitter } from "../../application/ports/worker-committer.js";
import { gitCommand } from "./git-command.js";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Compare every hooks file (including ignored/untracked files) with HEAD, without running filters. */
function hooksTrusted(cwd: string): boolean {
  const configured = gitCommand(cwd, ["config", "--path", "--get", "core.hooksPath"], {
    runHooks: true,
    allowedCodes: [0, 1],
  });
  const path =
    configured.code === 0
      ? configured.stdout
      : gitCommand(cwd, ["rev-parse", "--git-path", "hooks"], { runHooks: true }).stdout;
  const root = resolve(cwd, path.replace(/\n$/, ""));
  const prefix = relative(cwd, root);
  const tracked = new Map<string, { mode: string; hash: string }>();
  if (prefix !== ".." && !prefix.startsWith("../")) {
    if (
      gitCommand(cwd, [
        "--literal-pathspecs",
        "diff",
        "--cached",
        "--name-only",
        "-z",
        "HEAD",
        "--",
        prefix || ".",
      ]).stdout !== ""
    )
      return false;
    const tree = gitCommand(cwd, [
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "-z",
      "HEAD",
      "--",
      prefix || ".",
    ]).stdout;
    for (const entry of tree.split("\0").filter(Boolean)) {
      const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/s.exec(entry);
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined)
        return false;
      tracked.set(resolve(cwd, match[3]), { mode: match[1], hash: match[2] });
    }
  }
  function walk(path: string): boolean {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || realpathSync(path) !== path) return false;
    if (stat.isDirectory()) return readdirSync(path).every((name) => walk(join(path, name)));
    const expected = tracked.get(path);
    if (!stat.isFile() || expected === undefined) return false;
    if (((stat.mode & 0o111) !== 0) !== (expected.mode === "100755")) return false;
    const hash = gitCommand(cwd, ["hash-object", "--no-filters", "--", path]).stdout.trim();
    tracked.delete(path);
    return hash === expected.hash;
  }
  try {
    lstatSync(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return tracked.size === 0;
    throw error;
  }
  return walk(root) && tracked.size === 0;
}

export function createCliWorkerCommitter(): WorkerCommitter {
  return {
    hooksTrusted,
    committedPaths: (cwd, baseSha, headSha) =>
      gitCommand(cwd, ["diff", "--name-only", "--no-renames", "-z", baseSha, headSha, "--"])
        .stdout.split("\0")
        .filter(Boolean),
    undoCommit: (cwd, baseSha) => {
      gitCommand(cwd, ["reset", "--soft", baseSha]);
      gitCommand(cwd, ["restore", "--staged", "--source=HEAD", "--", "."]);
    },
    stagedPaths: (cwd) =>
      gitCommand(cwd, ["diff", "--cached", "--name-only", "--no-renames", "-z"])
        .stdout.split("\0")
        .filter(Boolean),
    stage: (cwd, paths) => {
      gitCommand(cwd, ["--literal-pathspecs", "add", "--all", "--", ...paths]);
    },
    unstage: (cwd, paths) => {
      gitCommand(cwd, [
        "--literal-pathspecs",
        "restore",
        "--staged",
        "--source=HEAD",
        "--",
        ...paths,
      ]);
    },
    commit: (cwd, message) => {
      gitCommand(cwd, ["commit", "-m", message], { runHooks: true });
      return gitCommand(cwd, ["rev-parse", "HEAD"]).stdout.trim();
    },
  };
}
