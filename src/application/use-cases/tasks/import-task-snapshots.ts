import { importTaskSelectionSchema } from "../../contracts/task-import.js";
import { isTaskImportable } from "../../../domain/tasks/dependency-policy.js";
import type { ProjectConfig } from "../../contracts/project-config.js";
import { TaskImportError } from "../../ports/github-task-reader.js";
import type { GithubTaskReader } from "../../ports/github-task-reader.js";
import type { TaskImportSource, TaskImportProjectStore } from "../../ports/task-import-source.js";
import { importTask } from "./import-task.js";
import { storeTaskSnapshots, type StoreTaskSnapshotsDependencies } from "./store-task-snapshots.js";

/** Import a complete selected scope before persisting its business approval baselines. */
export async function importTaskSnapshots(
  deps: StoreTaskSnapshotsDependencies & {
    readonly config: ProjectConfig;
    readonly source: TaskImportSource;
    readonly reader: GithubTaskReader;
    readonly projects: TaskImportProjectStore;
  },
  input: unknown,
) {
  const parsed = importTaskSelectionSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, reason: "INVALID_INPUT" };
  try {
    const selection = await deps.source.resolve(deps.config, [
      ...new Set(parsed.data.issueNumbers),
    ]);
    const imported = await importTask(deps, {
      schemaVersion: 1,
      repository: deps.config.repository,
      projectId: selection.projectId,
      scope: { kind: "list", issueIds: selection.issueIds },
    });
    if (
      selection.issueIds.some((id) => {
        const snapshot = imported.snapshots.find((s) => s.issue.id === id);
        const item = imported.items.find((item) => item.issueId === id && !item.archived);
        return (
          snapshot === undefined ||
          item === undefined ||
          !isTaskImportable({ ...snapshot.issue, kind: item.kind, archived: item.archived })
        );
      })
    )
      return { ok: false as const, reason: "ISSUE_NOT_IMPORTABLE" };
    const projectId = deps.projects.ensure(
      `${deps.config.repository.owner}/${deps.config.repository.name}`,
      selection.projectId,
      deps.hasher.sha256(JSON.stringify(deps.config)),
    );
    if (projectId === undefined) return { ok: false as const, reason: "PROJECT_LOCK_LOST" };
    const stored = storeTaskSnapshots(deps, { projectId, imported });
    if (!stored.ok) return stored;
    return {
      ok: true as const,
      snapshots: stored.snapshots.map((s) => {
        const snapshot = imported.snapshots.find((snapshot) => snapshot.issue.id === s.issueNodeId);
        if (snapshot === undefined) throw new Error("STORED_SNAPSHOT_MISSING");
        return {
          taskId: s.taskId,
          contentHash: snapshot.contentHash,
          outcome: s.outcome,
        };
      }),
    };
  } catch (error) {
    if (error instanceof TaskImportError) return { ok: false as const, reason: error.code };
    throw error;
  }
}
