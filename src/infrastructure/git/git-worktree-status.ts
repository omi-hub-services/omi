import fs from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { GitWorkspaceError } from "../../application/ports/git-workspace.js";
import { gitCommand } from "./git-command.js";
import { parseStatus } from "./git-worktree-output.js";

/** Git status trusts these index flags, and worktree remove can delete edits they conceal. */
function concealedPaths(worktree: string): string[] {
  const output = gitCommand(worktree, ["ls-files", "-v", "-z"]).stdout;
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new GitWorkspaceError("GIT_FAILED");
  const paths: string[] = [];
  for (const record of output.slice(0, -1).split("\0")) {
    if (!/^[HSMRCK?hsmrck] .+$/s.test(record)) throw new GitWorkspaceError("GIT_FAILED");
    const flag = record.slice(0, 1);
    const path = record.slice(2);
    if (isAbsolute(path) || path.split("/").includes("..")) {
      throw new GitWorkspaceError("GIT_FAILED");
    }
    // Absent skip-worktree files are normal in sparse checkouts. Existing ones need checking.
    if (
      (flag === "S" || flag === "s") &&
      fs.lstatSync(join(worktree, path), { throwIfNoEntry: false }) === undefined
    )
      continue;
    if (flag === "S" || flag !== flag.toUpperCase()) paths.push(path);
  }
  return paths;
}

export function inspectGitStatus(worktree: string): ReturnType<typeof parseStatus> {
  const args = [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
    "--ignore-submodules=none",
  ];
  const paths = concealedPaths(worktree);
  if (paths.length === 0) return parseStatus(gitCommand(worktree, args).stdout);

  const directory = fs.mkdtempSync(join(tmpdir(), "omi-git-status-"));
  try {
    const indexFile = join(directory, "index");
    const output = gitCommand(worktree, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ]).stdout;
    if (!output.endsWith("\n") || !isAbsolute(output.slice(0, -1))) {
      throw new GitWorkspaceError("GIT_FAILED");
    }
    fs.copyFileSync(output.slice(0, -1), indexFile);
    const options = { indexFile, input: `${paths.join("\0")}\0` };
    // Keep split-index rewrites inside the temporary directory as well.
    gitCommand(worktree, ["update-index", "--no-split-index"], { indexFile });
    gitCommand(worktree, ["update-index", "--no-assume-unchanged", "-z", "--stdin"], options);
    gitCommand(worktree, ["update-index", "--no-skip-worktree", "-z", "--stdin"], options);
    return parseStatus(gitCommand(worktree, args, { indexFile }).stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
