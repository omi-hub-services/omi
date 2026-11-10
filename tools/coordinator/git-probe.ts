// Branch state of a checkout from read-only git calls. The same reads serve the WSL checkout
// (each call through wsl.exe, or bash inside Linux) and the Coordinator's Windows clone (plain
// argv); only how one git argv becomes a Command differs.
import { BASE_BRANCH, type WslTarget } from "./coordinator-settings.ts";
import type { CleanupState } from "./flow-plans.ts";
import { joinSteps, runChecked, wslCommand, type Command, type Runner } from "./process-runner.ts";

export interface ProbeOptions {
  /** `git fetch --prune origin` first, so "merged" is judged against the real origin/develop. */
  readonly fetch?: boolean;
  /** Also read the branch SHA on origin (network). */
  readonly remote?: boolean;
}

export interface ProbedState extends CleanupState {
  readonly head: string;
  readonly remote: string | null;
}

export type GitCommand = (args: readonly string[]) => Command;

export const wslGit =
  (target: WslTarget): GitCommand =>
  (args) =>
    wslCommand(joinSteps([["git", ...args]]), target);

export const localGit =
  (cwd: string): GitCommand =>
  (args) => ({ file: "git", args, cwd });

/** A read that fails throws, so a broken call never looks like a clean checkout. */
export async function probeBranch(
  run: Runner,
  git: GitCommand,
  branch: string,
  options: ProbeOptions = {},
): Promise<ProbedState> {
  const ref = `refs/heads/${branch}`;
  if (options.fetch) await run(git(["fetch", "--prune", "--quiet", "origin"]));
  const read = async (...args: string[]) => (await runChecked(run, git(args))).trim();
  const [current, local, tracked, all, head, merged, remote] = await Promise.all([
    read("rev-parse", "--abbrev-ref", "HEAD"),
    run(git(["rev-parse", "--verify", "--quiet", ref])),
    read("status", "--porcelain", "--untracked-files=no"),
    read("status", "--porcelain"),
    read("rev-parse", "HEAD"),
    run(git(["merge-base", "--is-ancestor", ref, `origin/${BASE_BRANCH}`])),
    options.remote ? read("ls-remote", "origin", ref) : "",
  ]);
  return {
    current,
    local: local.code === 0 ? local.stdout.trim() : null,
    dirty: tracked !== "",
    clean: all === "",
    head,
    merged: merged.code === 0,
    remote: remote.split(/\s/)[0] || null,
  };
}
