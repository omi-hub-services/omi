import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RegressionExecutor } from "../../application/ports/regression-runner.js";
import { gitCommand } from "../git/git-command.js";
import { checkEnvironment } from "./process-check-runner.js";
import { startSupervisedProcess } from "./supervised-process.js";

export interface RegressionExecutorOptions {
  /** The worktree holding the fix and the regression test: the head. */
  readonly workspacePath: string;
  /** The revision the fix branched from. The base run reverts every fix file to it. */
  readonly baseSha: string;
  readonly testFile: string;
  readonly timeoutMs: number;
}

async function runArgv(cwd: string, argv: readonly string[], timeoutMs: number) {
  const [executable, ...args] = argv;
  if (executable === undefined) return null;
  try {
    const child = await startSupervisedProcess({
      executable,
      args,
      cwd,
      env: checkEnvironment(),
      stdin: "",
      timeoutMs,
      graceMs: 2000,
      maxStdoutChars: 64_000_000,
      maxLineChars: 1_000_000,
      maxStderrChars: 64_000,
      onStdoutLine: () => undefined,
    });
    const exit = await child.exit;
    return exit.timedOut || exit.stdoutOverflow ? null : exit.exitCode;
  } catch {
    return null; // the command could not start: no exit status, so no evidence
  }
}

/**
 * Runs the regression command on the head in the worktree, and on the base in a throwaway
 * worktree at `baseSha` where only the test file is copied from the head: every fix file is
 * therefore reverted. The throwaway worktree is always removed.
 */
export function createRegressionExecutor(options: RegressionExecutorOptions): RegressionExecutor {
  return async (where, argv) => {
    if (where === "head") {
      const revision = gitCommand(options.workspacePath, ["rev-parse", "HEAD"]).stdout.trim();
      return { revision, exitCode: await runArgv(options.workspacePath, argv, options.timeoutMs) };
    }
    const revision = gitCommand(options.workspacePath, [
      "rev-parse",
      "--verify",
      `${options.baseSha}^{commit}`,
    ]).stdout.trim();
    const parent = mkdtempSync(join(tmpdir(), "omi-regression-"));
    const tree = join(parent, "base");
    try {
      gitCommand(options.workspacePath, ["worktree", "add", "--detach", tree, revision]);
      mkdirSync(dirname(join(tree, options.testFile)), { recursive: true });
      copyFileSync(join(options.workspacePath, options.testFile), join(tree, options.testFile));
      const modules = join(options.workspacePath, "node_modules");
      if (existsSync(modules)) symlinkSync(modules, join(tree, "node_modules"));
      return { revision, exitCode: await runArgv(tree, argv, options.timeoutMs) };
    } finally {
      try {
        gitCommand(options.workspacePath, ["worktree", "remove", "--force", tree]);
      } catch {
        /* the directory is removed below; a stale worktree entry is pruned by git */
      }
      rmSync(parent, { recursive: true, force: true });
    }
  };
}
