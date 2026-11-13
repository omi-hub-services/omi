import { syncSelectionSchema, type SyncReport } from "../../contracts/sync.js";
import type { ProjectSession } from "../../ports/lease-store.js";
import { PROJECT_OWNER_LEASE_KEY } from "../../ports/lease-store.js";
import type { importTaskSnapshots } from "../tasks/import-task-snapshots.js";
import { flushOutbox, type FlushOutboxDeps } from "./flush-outbox.js";

export interface SyncGithubDependencies extends FlushOutboxDeps {
  readonly session: ProjectSession;
  readonly importTasks: (input: unknown) => ReturnType<typeof importTaskSnapshots>;
}

/** A sync pass only drains existing intents; importing snapshots never queues GitHub writes. */
export async function syncGithub(deps: SyncGithubDependencies, input: unknown) {
  const parsed = syncSelectionSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, reason: "INVALID_INPUT" };
  const locked = () =>
    deps.session.lease.resourceKey === PROJECT_OWNER_LEASE_KEY && deps.session.renew();
  if (!locked()) return { ok: false as const, reason: "PROJECT_LOCK_LOST" };
  // flushOutbox owns reconcile-before-send, budgets, backoff and batching.
  const flushed = await flushOutbox({
    ...deps,
    outbox: {
      get: (key) => deps.outbox.get(key),
      listDue: (at, limit) => deps.outbox.listDue(at, limit),
      listUnresolved: () => deps.outbox.listUnresolved(),
      transition: (change) =>
        locked()
          ? deps.outbox.transition({ ...change, fence: deps.session.lease })
          : { ok: false, reason: "STALE_LEASE" },
    },
  });
  const snapshots: SyncReport["snapshots"] = [];
  const report = {
    schemaVersion: 1 as const,
    ...flushed,
    snapshots,
    githubUnavailable: flushed.reconcile.githubUnavailable,
  };
  if (!locked()) return { ok: true as const, ...report, code: "PROJECT_LOCK_LOST" };
  const rateLimited =
    flushed.stopped === "RATE_LIMITED" ||
    flushed.reconcile.entries.some((e) => e.outcome === "unavailable" && e.code === "RATE_LIMITED");
  if (rateLimited) return { ok: true as const, ...report, code: "RATE_LIMITED" };
  if (report.githubUnavailable) return { ok: true as const, ...report, code: "GITHUB_UNAVAILABLE" };
  if (parsed.data.issueNumbers === undefined) return { ok: true as const, ...report };
  const imported = await deps.importTasks({ issueNumbers: parsed.data.issueNumbers });
  if (!locked()) return { ok: true as const, ...report, code: "PROJECT_LOCK_LOST" };
  if (!imported.ok) {
    const unavailable =
      /^(HTTP_\d+|AUTH_REQUIRED|GH_NOT_INSTALLED|CONNECTION_FAILED|TIMEOUT|INVALID_RESPONSE|RATE_LIMITED)$/.test(
        imported.reason,
      );
    return {
      ok: true as const,
      ...report,
      githubUnavailable: unavailable,
      code:
        imported.reason === "RATE_LIMITED"
          ? "RATE_LIMITED"
          : unavailable
            ? "GITHUB_UNAVAILABLE"
            : imported.reason,
    };
  }
  return { ok: true as const, ...report, snapshots: imported.snapshots };
}
