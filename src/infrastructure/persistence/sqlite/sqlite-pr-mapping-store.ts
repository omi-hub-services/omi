import { z } from "zod";
import { prMappingSchema } from "../../../application/contracts/pr-delivery.js";
import { DeliveryError } from "../../../application/ports/pr-delivery.js";
import type { PrMappingStore } from "../../../application/ports/pr-delivery.js";
import type { StateDatabase } from "./sqlite-connection.js";
import { runInTransaction } from "./sqlite-transaction.js";

const rowSchema = z.strictObject({
  external_id: z.string(),
  external_number: z.number().int().positive(),
});

/** Uses the existing github_mappings table: the local task key owns one Issue and one PR. */
export function createSqlitePrMappingStore(db: StateDatabase): PrMappingStore {
  const select = db.prepare(`SELECT external_id, external_number FROM github_mappings
    WHERE project_id = ? AND logical_key = ? AND entity_kind = ?`);
  const insert = db.prepare(`INSERT INTO github_mappings
    (project_id, logical_key, entity_kind, external_id, external_number) VALUES (?, ?, ?, ?, ?)`);
  return {
    get(projectId, taskId) {
      const issue = select.get(projectId, taskId, "issue");
      const pr = select.get(projectId, taskId, "pull_request");
      if (issue === undefined && pr === undefined) return undefined;
      const i = rowSchema.parse(issue);
      const p = rowSchema.parse(pr);
      const match = /^issue:([^#]+)#(\d+)$/.exec(i.external_id);
      const repository = match?.[1];
      if (
        repository === undefined ||
        Number(match?.[2]) !== i.external_number ||
        p.external_id !== `pull_request:${repository}#${String(p.external_number)}`
      )
        throw new DeliveryError("MAPPING_INVALID");
      return prMappingSchema.parse({
        projectId,
        taskId,
        repository,
        issueNumber: i.external_number,
        prNumber: p.external_number,
      });
    },
    save(input) {
      const mapping = prMappingSchema.parse(input);
      runInTransaction(db, () => {
        for (const [kind, number] of [
          ["issue", mapping.issueNumber],
          ["pull_request", mapping.prNumber],
        ] as const) {
          const identity = `${kind}:${mapping.repository}#${String(number)}`;
          const existing: unknown = select.get(mapping.projectId, mapping.taskId, kind);
          if (existing !== undefined) {
            const row = rowSchema.parse(existing);
            if (row.external_id !== identity || row.external_number !== number)
              throw new DeliveryError("MAPPING_CONFLICT");
          } else insert.run(mapping.projectId, mapping.taskId, kind, identity, number);
        }
      });
    },
  };
}
