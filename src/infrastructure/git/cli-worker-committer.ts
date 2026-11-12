import type { WorkerCommitter } from "../../application/ports/worker-committer.js";
import { gitCommand } from "./git-command.js";

export function createCliWorkerCommitter(): WorkerCommitter {
  return {
    stagedPaths: (cwd) =>
      gitCommand(cwd, ["diff", "--cached", "--name-only", "--no-renames", "-z"])
        .stdout.split("\0")
        .filter(Boolean),
    stage: (cwd, paths) => {
      gitCommand(cwd, ["--literal-pathspecs", "add", "--all", "--", ...paths]);
    },
    commit: (cwd, message) => {
      gitCommand(cwd, ["commit", "-m", message], { runHooks: true });
      return gitCommand(cwd, ["rev-parse", "HEAD"]).stdout.trim();
    },
  };
}
