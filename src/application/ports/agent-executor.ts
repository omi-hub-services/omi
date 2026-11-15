import type {
  ExecutionEvent,
  ExecutionHandle,
  ExecutionRequest,
  ExecutionResult,
  ProbeRequest,
  ProbeResult,
} from "../contracts/agent-execution.js";
import type { Executor } from "../contracts/model-capability.js";

export type AgentExecutorErrorCode =
  | "INVALID_REQUEST"
  | "SPAWN_FAILED"
  | "UNKNOWN_EXECUTION"
  /** The profile has installed skills; a worker may only see the skills inlined in its prompt. */
  | "CODEX_HOME_HAS_SKILLS";

/**
 * Operational failures that are not an attempt outcome: the request is invalid, the CLI could
 * not be started, or the handle is not known. Fixed messages never echo a path, prompt or
 * credential. A run that started and then failed is an `ExecutionResult`, not an error.
 */
export class AgentExecutorError extends Error {
  override readonly name = "AgentExecutorError";
  readonly code: AgentExecutorErrorCode;

  constructor(code: AgentExecutorErrorCode) {
    super(`Agent executor operation failed: ${code}`);
    this.code = code;
  }
}

/**
 * One coding-agent CLI run as a worker process. Implemented per tool (Claude Code, Codex); a
 * use case sees no flag, event name or file of either. The profile is selected per call by
 * `profileHome`: an adapter never switches or rewrites a global login, so runs on different
 * profiles can overlap.
 */
export interface AgentExecutor {
  readonly executor: Executor;

  /**
   * Checks CLI availability, version compatibility and login mode for one profile without
   * spending model quota. Resolves for every CLI state (problems are reported in `status`);
   * rejects only with `AgentExecutorError` `INVALID_REQUEST`.
   */
  probe(request: ProbeRequest): Promise<ProbeResult>;

  /**
   * Validates the request and spawns the worker. Resolves once the process exists, not when it
   * finishes. Rejects with `AgentExecutorError` (`INVALID_REQUEST`, `SPAWN_FAILED`, `CODEX_HOME_HAS_SKILLS`).
   */
  start(request: ExecutionRequest): Promise<ExecutionHandle>;

  /**
   * Progress signals from the beginning of the run, then completes when the run has finished.
   * Replayable: each call starts from the first event.
   */
  events(handle: ExecutionHandle): AsyncIterable<ExecutionEvent>;

  /**
   * Asks the worker to stop, then forces the whole process group down after a grace period.
   * Resolves when the process has exited. Idempotent; a no-op once the run has finished.
   */
  cancel(handle: ExecutionHandle): Promise<void>;

  /** Waits for the run to finish and returns its classified result. Idempotent. */
  collectResult(handle: ExecutionHandle): Promise<ExecutionResult>;
}
