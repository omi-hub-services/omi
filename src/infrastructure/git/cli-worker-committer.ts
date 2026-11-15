import type { WorkerCommitter } from "../../application/ports/worker-committer.js";
import { gitCommand } from "./git-command.js";

export function createCliWorkerCommitter(): WorkerCommitter {
  return {
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
      gitCommand(cwd, ["commit", "-m", message]);
      return gitCommand(cwd, ["rev-parse", "HEAD"]).stdout.trim();
    },
  };
}
