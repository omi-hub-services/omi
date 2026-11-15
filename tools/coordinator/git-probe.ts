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
// ponytail: one wsl.exe per read, run in parallel. Measured on Windows 2026-11-10 (n=15):
// median 233 ms vs 104 ms for one batched payload; ~130 ms per probe is not worth the extra
// parsing. If probes become hot, batch the reads into one payload (Windows-safe quoting rules).
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

/** Cleanup can be retried after its configured worktree directory has been removed. */
export async function probeCleanupWsl(
  run: Runner,
  target: WslTarget,
  branch: string,
  options: ProbeOptions,
): Promise<{ state: CleanupState | null; target: WslTarget; refusal?: string }> {
  const outside = { ...target, repoDir: "/" };
  const exists = await run(wslCommand(joinSteps([["test", "-d", target.repoDir]]), outside));
  if (exists.code === 1) {
    return {
      state: null,
      target: outside,
      refusal:
        `cleanup directory ${target.repoDir} is missing; cannot verify whether ${branch} remains. ` +
        `In the main repository, verify it is merged into origin/${BASE_BRANCH}, then run ` +
        `git -C <main-checkout> branch -d ${branch} with a HEAD containing the branch; ` +
        `do not force deletion`,
    };
  }
  if (exists.code !== 0) throw new Error(`cannot inspect cleanup directory: ${exists.stderr}`);
  const git = wslGit(target);
  const listing = await runChecked(run, git(["worktree", "list", "--porcelain", "-z"]));
  const trees = listing
    .split("\0\0")
    .filter(Boolean)
    .map((record) => {
      const lines = record.split("\0");
      const path = lines[0]?.slice("worktree ".length);
      if (!lines[0]?.startsWith("worktree ") || !path?.startsWith("/")) {
        throw new Error("invalid git worktree listing");
      }
      return { path, branch: lines.find((line) => line.startsWith("branch "))?.slice(7) };
    });
  const main = trees[0];
  if (!main) throw new Error("empty git worktree listing");
  const linked = trees.slice(1).find((tree) => tree.branch === `refs/heads/${branch}`);
  if (!linked) return { state: await probeBranch(run, git, branch, options), target };
  const changes = await runChecked(
    run,
    git([
      "-C",
      linked.path,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude)**/node_modules/**",
      ":(exclude)node_modules/**",
    ]),
  );
  const state = await probeBranch(
    run,
    git,
    branch,
    changes ? { ...options, fetch: false } : options,
  );
  return {
    state: {
      ...state,
      worktree: {
        path: linked.path,
        mainPath: main.path,
        mainBranch: main.branch,
        changes: changes.trimEnd(),
      },
    },
    target: { ...target, repoDir: main.path },
  };
}
