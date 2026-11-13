import { z } from "zod";
import type { TaskImportProjectStore } from "../../../application/ports/task-import-source.js";
import type { LeaseFence } from "../../../application/ports/state-unit-of-work.js";
import type { StateDatabase } from "./sqlite-connection.js";
import { runInTransaction } from "./sqlite-transaction.js";

/** Register the configured repository once under the runtime's writer fence. */
export function createSqliteTaskImportProjectStore(
  db: StateDatabase,
  fence: LeaseFence,
  now: () => number,
  nextId: () => string,
): TaskImportProjectStore {
  return {
    ensure(repository, remoteProjectId, configHash) {
      return runInTransaction(db, () => {
        const at = new Date(now()).toISOString();
        if (
          db
            .prepare(
              "SELECT 1 FROM leases WHERE resource_key=? AND owner=? AND generation=? AND expires_at>?",
            )
            .get(fence.resourceKey, fence.owner, fence.generation, at) === undefined
        )
          return undefined;
        const existing = db
          .prepare("SELECT id FROM projects WHERE repo_identity=? COLLATE NOCASE")
          .get(repository);
        if (existing !== undefined) return z.object({ id: z.string() }).parse(existing).id;
        const projectId = nextId();
        db.prepare(
          "INSERT INTO projects (id, repo_identity, github_project_node_id, config_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(projectId, repository, remoteProjectId, configHash, at, at);
        return projectId;
      });
    },
  };
}
