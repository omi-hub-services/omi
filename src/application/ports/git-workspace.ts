import type { UncommittedManifest } from "../contracts/checkpoint.js";
import type { Lease } from "./lease-store.js";

export interface UncommittedLimits {
  /** Defaults to 500. More changed files set `truncated`. */
  readonly maxEntries?: number;
  /** Files above this size are listed without a hash. Defaults to 10 MiB. */
  readonly maxFileBytes?: number;
}

export interface TaskWorkspaceId {
  readonly taskId: string;
  readonly slug: string;
}

export interface TaskWorkspace extends TaskWorkspaceId {
  readonly path: string;
  readonly branch: string;
}

export interface WorkspaceState {
  readonly path: string;
  readonly headSha: string;
  /** Null for a detached worktree. */
  readonly branch: string | null;
  /** Includes staged, unstaged, untracked and submodule changes. */
  readonly dirty: boolean;
  /** Cleanup also refuses ignored files, which Git can otherwise delete during removal. */
  readonly hasIgnoredFiles: boolean;
}

export interface WorkspaceLeaseRequest extends TaskWorkspaceId {
  readonly owner: string;
  readonly now: string;
  readonly expiresAt: string;
}

export interface WorkspaceWriterRequest extends TaskWorkspaceId {
  readonly owner: string;
  readonly generation: number;
  readonly now: string;
}

export type GitWorkspaceErrorCode =
  | "INVALID_INPUT"
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "DIRTY_WORKTREE"
  | "WRITER_HELD"
  | "STALE_LEASE"
  | "LEASE_EXPIRED"
  | "UNMERGED_WORK"
  | "UNPUSHED_WORK"
  | "GIT_FAILED"
  | "GIT_TIMEOUT"
  | "IO_FAILED";

/** Messages contain fixed codes only, keeping Git diagnostics and file contents private. */
export class GitWorkspaceError extends Error {
  override readonly name = "GitWorkspaceError";
  readonly code: GitWorkspaceErrorCode;

  constructor(code: GitWorkspaceErrorCode) {
    super(`Git workspace operation failed: ${code}`);
    this.code = code;
  }
}

export type GitWorkspaceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GitWorkspaceError };

export interface GitWorkspace {
  /** Committed PR paths relative to the integration branch; missing/failed reads fail closed. */
  changedPaths?(worktreePath: string): GitWorkspaceResult<readonly string[]>;
  /** Merge-base of the worktree's head with the integration branch, as the runtime sees it. */
  mergeBase?(worktreePath: string): GitWorkspaceResult<string>;
  /** Bounded committed delta on a clean task worktree, with external diff/textconv disabled. */
  diffSince?(worktreePath: string, headSha: string): GitWorkspaceResult<string>;
  /** Creates from local develop, or reconciles an existing matching branch/worktree on retry.
   * Refuses a dirty main checkout. Operations reserve the same lease as task writers.
   */
  createTask(request: WorkspaceLeaseRequest): GitWorkspaceResult<TaskWorkspace>;
  inspect(worktreePath: string): GitWorkspaceResult<WorkspaceState>;
  /** Bounded manifest of staged, unstaged and untracked files (path, status, content hash). Never
   * copies contents, never stashes or resets, and leaves credential-looking paths out. */
  listUncommitted(
    worktreePath: string,
    limits?: UncommittedLimits,
  ): GitWorkspaceResult<UncommittedManifest>;
  /** Explicit release is required even after expiry. All adapters must share the project store. */
  acquireWriter(request: WorkspaceLeaseRequest): GitWorkspaceResult<Lease>;
  renewWriter(
    request: WorkspaceWriterRequest & { readonly expiresAt: string },
  ): GitWorkspaceResult<Lease>;
  /** The runtime must confirm the writer process has stopped before releasing its reservation. */
  releaseWriter(request: WorkspaceWriterRequest): GitWorkspaceResult<void>;
  /** Requires a clean task, with HEAD reachable from local and fetched origin/develop.
   * Retains the task branch. A retry after successful removal succeeds.
   */
  removeTask(request: WorkspaceLeaseRequest): GitWorkspaceResult<void>;
}
