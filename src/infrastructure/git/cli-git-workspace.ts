import fs from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  GitWorkspaceError,
  type GitWorkspace,
  type GitWorkspaceResult,
  type TaskWorkspace,
  type TaskWorkspaceId,
  type WorkspaceLeaseRequest,
  type WorkspaceState,
} from "../../application/ports/git-workspace.js";
import type { Lease, LeaseStore } from "../../application/ports/lease-store.js";
import { worktreeLeaseKey } from "../../domain/runs/lease-resource.js";
import { gitCommand } from "./git-command.js";
import { gitObjectId, parseWorktrees } from "./git-worktree-output.js";
import { inspectGitStatus } from "./git-worktree-status.js";

const taskShape = {
  taskId: z
    .string()
    .regex(/^omi-\d{3,}$/)
    .max(40),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(100),
};
const holderShape = {
  ...taskShape,
  owner: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\0\r\n]+$/),
  now: z.iso.datetime({ precision: 3 }),
};
const taskSchema = z.object(taskShape);
const leaseSchema = z.strictObject({ ...holderShape, expiresAt: z.iso.datetime({ precision: 3 }) });
const writerSchema = z.strictObject({ ...holderShape, generation: z.number().int().positive() });
const renewalSchema = writerSchema.extend({ expiresAt: z.iso.datetime({ precision: 3 }) });

export interface GitWorkspaceOptions {
  readonly mainWorktreePath: string;
  /** Defaults to <main-checkout-name>-worktrees, in the main checkout's parent directory. */
  readonly worktreesRoot?: string;
}

function validate(schema: z.ZodType, value: unknown): void {
  if (!schema.safeParse(value).success) throw new GitWorkspaceError("INVALID_INPUT");
}

function attempt<T>(operation: () => T): GitWorkspaceResult<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof GitWorkspaceError ? error : new GitWorkspaceError("IO_FAILED"),
    };
  }
}

function exists(path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Local, bounded argv-only Git operations. Bootstrap supplies the shared project LeaseStore. */
export function createCliGitWorkspace(
  options: GitWorkspaceOptions,
  leases: LeaseStore,
): GitWorkspace {
  const main = fs.realpathSync(options.mainWorktreePath);
  const root = resolve(options.worktreesRoot ?? join(dirname(main), `${basename(main)}-worktrees`));
  const topLevel = gitCommand(main, ["rev-parse", "--show-toplevel"]).stdout;
  if (topLevel !== `${main}\n` || dirname(root) !== dirname(main) || root === main) {
    throw new GitWorkspaceError("INVALID_PATH");
  }

  function checkRoot(): void {
    if (exists(root) && (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root)) {
      throw new GitWorkspaceError("INVALID_PATH");
    }
  }

  function taskWorkspace(id: TaskWorkspaceId): TaskWorkspace {
    validate(taskSchema, id);
    checkRoot();
    const name = `${id.taskId}-${id.slug}`;
    const path = join(root, name);
    if (exists(path) && (!fs.lstatSync(path).isDirectory() || fs.realpathSync(path) !== path)) {
      throw new GitWorkspaceError("INVALID_PATH");
    }
    return { taskId: id.taskId, slug: id.slug, path, branch: `task/${name}` };
  }

  function entries() {
    return parseWorktrees(gitCommand(main, ["worktree", "list", "--porcelain", "-z"]).stdout);
  }

  function inspect(path: string): WorkspaceState {
    if (typeof path !== "string" || !isAbsolute(path) || !exists(path)) {
      throw new GitWorkspaceError("INVALID_PATH");
    }
    const canonical = fs.realpathSync(path);
    const entry = entries().find((item) => item.path === canonical);
    if (entry === undefined) throw new GitWorkspaceError("NOT_FOUND");
    return {
      path: canonical,
      headSha: entry.headSha,
      branch: entry.branch,
      ...inspectGitStatus(canonical),
    };
  }

  function requireTask(workspace: TaskWorkspace): void {
    const entry = entries().find((item) => item.path === workspace.path);
    if (entry === undefined) throw new GitWorkspaceError("NOT_FOUND");
    if (entry.branch !== workspace.branch || entry.locked || !exists(workspace.path)) {
      throw new GitWorkspaceError("ALREADY_EXISTS");
    }
  }

  function acquire(request: WorkspaceLeaseRequest, workspace: TaskWorkspace): Lease {
    validate(leaseSchema, request);
    if (request.expiresAt <= request.now) throw new GitWorkspaceError("INVALID_INPUT");
    const result = leases.acquire({
      resourceKey: worktreeLeaseKey(workspace.path),
      owner: request.owner,
      now: request.now,
      expiresAt: request.expiresAt,
      reclaimExpired: false,
    });
    if (!result.ok) throw new GitWorkspaceError("WRITER_HELD");
    return result.lease;
  }

  function reserved<T>(
    request: WorkspaceLeaseRequest,
    operation: (workspace: TaskWorkspace) => T,
  ): T {
    const workspace = taskWorkspace(request);
    const lease = acquire(request, workspace);
    const outcome = attempt(() => operation(workspace));
    // Expiry cannot transfer this reservation. A crash leaves it held for explicit recovery.
    const released = attempt(() => leases.release({ ...lease, now: request.now }));
    if (!outcome.ok) throw outcome.error;
    if (!released.ok) throw released.error;
    if (!released.value.ok) throw new GitWorkspaceError("STALE_LEASE");
    return outcome.value;
  }

  function refExists(ref: string): boolean {
    return (
      gitCommand(main, ["show-ref", "--verify", "--quiet", ref], { allowedCodes: [0, 1] }).code ===
      0
    );
  }

  checkRoot();
  return {
    createTask(request) {
      return attempt(() =>
        reserved(request, (workspace) => {
          if (inspect(main).dirty) throw new GitWorkspaceError("DIRTY_WORKTREE");
          const existing = entries().find((item) => item.path === workspace.path);
          if (existing !== undefined) {
            requireTask(workspace);
            return workspace;
          }
          if (exists(workspace.path) || refExists(`refs/heads/${workspace.branch}`)) {
            throw new GitWorkspaceError("ALREADY_EXISTS");
          }
          if (!refExists("refs/heads/develop")) throw new GitWorkspaceError("NOT_FOUND");
          fs.mkdirSync(root, { recursive: true });
          const baseSha = gitObjectId(gitCommand(main, ["rev-parse", "refs/heads/develop"]).stdout);
          gitCommand(main, [
            "worktree",
            "add",
            "-b",
            workspace.branch,
            "--",
            workspace.path,
            baseSha,
          ]);
          requireTask(workspace);
          return workspace;
        }),
      );
    },
    inspect(path) {
      return attempt(() => inspect(path));
    },
    acquireWriter(request) {
      return attempt(() => {
        const workspace = taskWorkspace(request);
        const lease = acquire(request, workspace);
        try {
          requireTask(workspace);
          return lease;
        } catch (error) {
          attempt(() => leases.release({ ...lease, now: request.now }));
          throw error;
        }
      });
    },
    renewWriter(request) {
      return attempt(() => {
        validate(renewalSchema, request);
        if (request.expiresAt <= request.now) throw new GitWorkspaceError("INVALID_INPUT");
        const workspace = taskWorkspace(request);
        const result = leases.renew({ ...request, resourceKey: worktreeLeaseKey(workspace.path) });
        if (!result.ok) throw new GitWorkspaceError(result.reason);
        return result.lease;
      });
    },
    releaseWriter(request) {
      return attempt(() => {
        validate(writerSchema, request);
        const workspace = taskWorkspace(request);
        const result = leases.release({
          ...request,
          resourceKey: worktreeLeaseKey(workspace.path),
        });
        if (!result.ok) throw new GitWorkspaceError(result.reason);
      });
    },
    removeTask(request) {
      return attempt(() => {
        reserved(request, (workspace) => {
          const registered = entries().some((item) => item.path === workspace.path);
          if (!registered && !exists(workspace.path)) return;
          requireTask(workspace);
          const state = inspect(workspace.path);
          if (state.dirty || state.hasIgnoredFiles) throw new GitWorkspaceError("DIRTY_WORKTREE");
          if (
            gitCommand(main, ["merge-base", "--is-ancestor", state.headSha, "refs/heads/develop"], {
              allowedCodes: [0, 1],
            }).code !== 0
          ) {
            throw new GitWorkspaceError("UNMERGED_WORK");
          }
          if (
            !refExists("refs/remotes/origin/develop") ||
            gitCommand(
              main,
              ["merge-base", "--is-ancestor", state.headSha, "refs/remotes/origin/develop"],
              { allowedCodes: [0, 1] },
            ).code !== 0
          ) {
            throw new GitWorkspaceError("UNPUSHED_WORK");
          }
          gitCommand(main, ["worktree", "remove", "--", workspace.path]);
        });
      });
    },
  };
}
