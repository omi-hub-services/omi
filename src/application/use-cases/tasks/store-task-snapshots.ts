import { z } from "zod";
import { identifierSchema } from "../../contracts/identifiers.js";
import { importedTasksSchema } from "../../contracts/task-import.js";
import { invalidateStaleBusinessApprovals } from "../../services/invalidate-stale-business-approvals.js";
import type { ApprovalListReader, ApprovalSubjectReader } from "../../ports/approval-store.js";
import type { ContentHasher } from "../../ports/content-hasher.js";
import type { StateRejection, StateUnitOfWork } from "../../ports/state-unit-of-work.js";

const storeTaskSnapshotsSchema = z.strictObject({
  projectId: identifierSchema,
  imported: importedTasksSchema,
});

export interface StoreTaskSnapshotsDependencies {
  readonly unitOfWork: StateUnitOfWork;
  /** Lets a changed hash invalidate the task's now-stale business approvals. */
  readonly approvals: {
    readonly store: ApprovalListReader;
    readonly subjects: ApprovalSubjectReader;
  };
  readonly hasher: ContentHasher;
  readonly now: () => number;
  readonly nextId: () => string;
}

export type StoreTaskSnapshotsResult =
  | {
      readonly ok: true;
      readonly snapshots: readonly {
        readonly taskId: string;
        readonly issueNodeId: string;
        readonly issueNumber: number;
        readonly outcome: "stored" | "unchanged";
      }[];
    }
  | { readonly ok: false; readonly reason: "INVALID_INPUT" }
  | {
      readonly ok: false;
      readonly reason: "HASH_MISMATCH" | "ISSUE_NUMBER_CONFLICT";
      readonly issueNodeId: string;
    }
  | {
      readonly ok: false;
      readonly reason: Exclude<StateRejection, "UNCHANGED" | "CONFLICT">;
    };

/**
 * Persist an `importTask` result into `task_snapshots`, one change per snapshot. A rerun is
 * idempotent (same hash writes nothing); a stopped import leaves earlier snapshots stored, which
 * the next rerun reports as unchanged. The local task id is `task-<Issue number>`, so callers can
 * name the business approval subject without a lookup.
 */
export function storeTaskSnapshots(
  deps: StoreTaskSnapshotsDependencies,
  input: unknown,
): StoreTaskSnapshotsResult {
  const parsed = storeTaskSnapshotsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const { projectId, imported } = parsed.data;
  // The hash becomes the business approval baseline, so never trust one supplied with the data.
  for (const snapshot of imported.snapshots) {
    const content = { schemaVersion: snapshot.schemaVersion, issue: snapshot.issue };
    if (deps.hasher.sha256(JSON.stringify(content)) !== snapshot.contentHash)
      return { ok: false, reason: "HASH_MISMATCH", issueNodeId: snapshot.issue.id };
  }
  const scope = JSON.stringify(imported.scope);
  const stored: {
    taskId: string;
    issueNodeId: string;
    issueNumber: number;
    outcome: "stored" | "unchanged";
  }[] = [];
  for (const { issue, contentHash } of imported.snapshots) {
    const taskId = `task-${String(issue.number)}`;
    const now = deps.now();
    const eventId = deps.nextId();
    const committed = deps.unitOfWork.commit({
      target: {
        kind: "task_snapshot",
        snapshot: {
          id: taskId,
          projectId,
          issueNodeId: issue.id,
          issueNumber: issue.number,
          contentHash,
          remoteUpdatedAt: issue.updatedAt,
          scope,
        },
      },
      at: new Date(now).toISOString(),
      event: {
        eventId,
        kind: "task.imported",
        subject: `task_snapshot:${taskId}`,
        correlationId: eventId,
        payload: JSON.stringify({
          taskId,
          projectId,
          issueNodeId: issue.id,
          issueNumber: issue.number,
          contentHash,
        }),
      },
    });
    if (committed.ok || committed.reason === "UNCHANGED") {
      // Also on UNCHANGED, so an earlier interrupted invalidation is finished by the next import.
      invalidateStaleBusinessApprovals(
        {
          approvals: deps.approvals.store,
          subjects: deps.approvals.subjects,
          unitOfWork: deps.unitOfWork,
          now: deps.now,
          nextId: deps.nextId,
        },
        taskId,
      );
      stored.push({
        taskId,
        issueNodeId: issue.id,
        issueNumber: issue.number,
        outcome: committed.ok ? "stored" : "unchanged",
      });
    } else if (committed.reason === "CONFLICT") {
      return { ok: false, reason: "ISSUE_NUMBER_CONFLICT", issueNodeId: issue.id };
    } else {
      return { ok: false, reason: committed.reason };
    }
  }
  return { ok: true, snapshots: stored };
}
