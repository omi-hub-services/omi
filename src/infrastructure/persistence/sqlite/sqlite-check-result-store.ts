import { z } from "zod";
import { checkRunRecordSchema } from "../../../application/contracts/check-run.js";
import type { CheckResultStore } from "../../../application/ports/check-result-store.js";
import type { LeaseFence } from "../../../application/ports/state-unit-of-work.js";
import type { StateDatabase } from "./sqlite-connection.js";

/**
 * Reusable passed checks as append-only `check.passed` events (no new table): correlated by the
 * revision, subject = check id. A restart finds them again; the newest matching event wins.
 */
export function createSqliteCheckResultStore(
  db: StateDatabase,
  options: {
    readonly fence: LeaseFence;
    readonly now: () => number;
    readonly nextId: () => string;
  },
): CheckResultStore {
  return {
    find(checkId, revision, command) {
      const rows = db
        .prepare(
          "SELECT payload FROM events WHERE kind='check.passed' AND correlation_id=? AND subject=? ORDER BY sequence DESC",
        )
        .all(revision, checkId);
      for (const row of rows) {
        const { payload } = z.object({ payload: z.string() }).parse(row);
        const parsed = checkRunRecordSchema.safeParse(JSON.parse(payload));
        if (
          parsed.success &&
          parsed.data.status === "passed" &&
          parsed.data.revision === revision &&
          JSON.stringify(parsed.data.command) === JSON.stringify(command)
        )
          return parsed.data;
      }
      return undefined;
    },
    save(record) {
      const { resourceKey, owner, generation } = options.fence;
      const at = new Date(options.now()).toISOString();
      if (
        db
          .prepare(
            "SELECT 1 FROM leases WHERE resource_key=? AND owner=? AND generation=? AND expires_at>?",
          )
          .get(resourceKey, owner, generation, at) === undefined
      )
        throw new Error("STALE_LEASE");
      db.prepare(
        "INSERT INTO events (event_id, kind, subject, run_id, correlation_id, payload, occurred_at) VALUES (?, 'check.passed', ?, NULL, ?, ?, ?)",
      ).run(
        options.nextId(),
        record.checkId,
        record.revision,
        JSON.stringify(checkRunRecordSchema.parse(record)),
        at,
      );
    },
  };
}
