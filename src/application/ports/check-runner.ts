import type { CheckRunRecord } from "../contracts/check-run.js";

export interface CheckRunRequest {
  readonly attemptId: string;
  readonly checkId: string;
  /** The attempt's worktree: the only place a check runs. */
  readonly workspacePath: string;
  /** Relative artifact prefix of the attempt; the evidence is stored under it. */
  readonly artifactRoot: string;
}

/** Runs a project check itself, so a test result is never taken from a worker's report. */
export interface CheckRunner {
  /** True when the runtime has a command for this check id and must run it. */
  has(checkId: string): boolean;
  /**
   * Runs the configured command in the worktree and stores command, exit status, times,
   * revision and a bounded, redacted log as an artifact. A failing or timed-out command is a
   * result, not an error; an unknown id throws `CHECK_UNKNOWN`.
   */
  run(request: CheckRunRequest): Promise<CheckRunRecord>;
}
