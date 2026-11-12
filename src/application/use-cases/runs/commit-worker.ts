import { z } from "zod";
import { contextPacketSchema } from "../../contracts/context.js";
import { assertCredentialFree, CredentialInputError } from "../../contracts/credential-input.js";
import { gitShaSchema, identifierSchema, relativePathSchema } from "../../contracts/identifiers.js";
import type { ArtifactStore } from "../../ports/artifact-store.js";
import type { AttemptStore } from "../../ports/attempt-store.js";
import type { GitWorkspace } from "../../ports/git-workspace.js";
import type { WorkerCommitter } from "../../ports/worker-committer.js";

export interface CommitWorkerDeps {
  readonly attempts: AttemptStore;
  readonly artifacts: ArtifactStore;
  readonly workspaces: GitWorkspace;
  readonly committer: WorkerCommitter;
  readonly now: () => number;
  readonly nextId: () => string;
}

/** Take the same writer lease as dispatch; a stopped status alone cannot exclude another writer. */
export function commitWorker(deps: CommitWorkerDeps, input: unknown) {
  const parsed = z
    .strictObject({ attemptId: identifierSchema, message: z.string().trim().min(1).max(2000) })
    .safeParse(input);
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!parsed.success) return refuse("INVALID_INPUT");
  const attempt = deps.attempts.get(parsed.data.attemptId);
  if (attempt === undefined) return refuse("ATTEMPT_NOT_FOUND");
  if (["pending", "running", "interrupted"].includes(attempt.status))
    return refuse("WORKER_NOT_STOPPED");
  const packet = contextPacketSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(deps.artifacts.read(attempt.contextPacket)),
    ) as unknown,
  );
  const paths = packet.allowedScope.paths;
  const allowed = (path: string) => {
    if (
      !relativePathSchema.safeParse(path).success ||
      /^(?:\.claude|\.agents|\.codex|\.git|\.tmp)(?:\/|$)|^\.omi-squad\/local(?:\/|$)/.test(path)
    )
      return false;
    try {
      assertCredentialFree(path);
    } catch (error) {
      if (error instanceof CredentialInputError) return false;
      throw error;
    }
    return paths.some((scope) => path === scope || path.startsWith(`${scope.replace(/\/$/, "")}/`));
  };
  if (!paths.every(allowed)) return refuse("UNSAFE_SCOPE");
  const at = deps.now();
  const owner = deps.nextId();
  const lease = deps.workspaces.acquireWriter({
    taskId: attempt.workspace.taskId,
    slug: attempt.workspace.slug,
    owner,
    now: new Date(at).toISOString(),
    expiresAt: new Date(at + 120_000).toISOString(),
  });
  if (!lease.ok) return refuse(lease.error.code);
  const execute = () => {
    const state = deps.workspaces.inspect(attempt.workspace.path);
    if (!state.ok) return refuse(state.error.code);
    if (state.value.branch !== attempt.workspace.branch) return refuse("BRANCH_MISMATCH");
    if (!deps.committer.hooksTrusted(attempt.workspace.path)) return refuse("UNTRUSTED_HOOKS");
    if (!deps.committer.stagedPaths(attempt.workspace.path).every(allowed))
      return refuse("UNSAFE_INDEX");
    deps.committer.stage(attempt.workspace.path, paths);
    const staged = deps.committer.stagedPaths(attempt.workspace.path);
    if (staged.length === 0) return refuse("NOTHING_TO_COMMIT");
    const unsafe = staged.filter((path) => !allowed(path));
    if (unsafe.length > 0) {
      deps.committer.unstage(attempt.workspace.path, unsafe);
      return refuse("UNSAFE_INDEX");
    }
    if (!deps.committer.hooksTrusted(attempt.workspace.path)) return refuse("UNTRUSTED_HOOKS");
    const committed = deps.committer.commit(attempt.workspace.path, parsed.data.message);
    let headSha: string;
    let safe: boolean;
    try {
      headSha = gitShaSchema.parse(committed);
      safe = deps.committer
        .committedPaths(attempt.workspace.path, state.value.headSha, headSha)
        .every(allowed);
    } catch (error) {
      deps.committer.undoCommit(attempt.workspace.path, state.value.headSha);
      throw error;
    }
    if (!safe) {
      deps.committer.undoCommit(attempt.workspace.path, state.value.headSha);
      return refuse("UNSAFE_COMMIT");
    }
    return {
      ok: true as const,
      attemptId: attempt.id,
      headSha,
    };
  };
  const release = () =>
    deps.workspaces.releaseWriter({
      taskId: attempt.workspace.taskId,
      slug: attempt.workspace.slug,
      owner,
      generation: lease.value.generation,
      now: new Date(deps.now()).toISOString(),
    });
  let result: ReturnType<typeof execute>;
  try {
    result = execute();
  } catch (error) {
    const released = release();
    if (!released.ok) return { ...refuse("WRITER_RELEASE_FAILED"), detail: released.error.code };
    throw error;
  }
  const released = release();
  return released.ok ? result : { ...refuse("WRITER_RELEASE_FAILED"), detail: released.error.code };
}
