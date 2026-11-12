import { spawnSync } from "node:child_process";
import { GitWorkspaceError } from "../../application/ports/git-workspace.js";

/** Local Git only. Ambient repository/index overrides must never redirect a command. */
interface GitCommandOptions {
  readonly allowedCodes?: readonly number[];
  readonly indexFile?: string;
  readonly input?: string;
}

export function gitCommand(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): { readonly stdout: string; readonly code: number } {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const result = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd,
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: "0",
        ...(options.indexFile === undefined ? {} : { GIT_INDEX_FILE: options.indexFile }),
      },
      input: options.input,
      shell: false,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) {
    throw new GitWorkspaceError(
      "code" in result.error && result.error.code === "ETIMEDOUT" ? "GIT_TIMEOUT" : "GIT_FAILED",
    );
  }
  if (result.status === null || !(options.allowedCodes ?? [0]).includes(result.status)) {
    throw new GitWorkspaceError("GIT_FAILED");
  }
  return { stdout: result.stdout, code: result.status };
}
