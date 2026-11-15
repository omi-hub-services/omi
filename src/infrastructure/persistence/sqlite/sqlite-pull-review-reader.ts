import { z } from "zod";
import type { PullReviewReader } from "../../../application/ports/pull-review-reader.js";
import type { StateDatabase } from "./sqlite-connection.js";

const eventRow = z.object({ kind: z.string(), payload: z.string(), dispatch_record: z.string() });
const payloadView = z.object({
  result: z.object({
    status: z.string(),
    revision: z.object({ headSha: z.string().regex(/^[0-9a-f]{40}$/) }),
  }),
});
const recordView = z.object({ role: z.object({ id: z.string() }) });

/**
 * The newest independent review of a task, from the reviewer step results the runtime recorded
 * (`step.succeeded` / `step.failed` events of a reviewer attempt that name a head). Text posted on
 * a PR is never read. A result without a head is not a review of anything and is skipped.
 */
export function createSqlitePullReviewReader(db: StateDatabase): PullReviewReader {
  const events = db.prepare(
    `SELECT e.kind, e.payload, a.dispatch_record
       FROM events e
       JOIN workflow_runs r ON r.id = e.run_id
       JOIN task_snapshots t ON t.id = r.task_id
       JOIN agent_attempts a ON a.id = json_extract(e.payload, '$.attemptId')
      WHERE t.issue_number = ? AND e.kind IN ('step.succeeded', 'step.failed')
        AND a.dispatch_record IS NOT NULL
      ORDER BY e.sequence DESC`,
  );
  return {
    latest(issueNumber) {
      for (const raw of events.iterate(issueNumber)) {
        const row = eventRow.parse(raw);
        if (recordView.parse(JSON.parse(row.dispatch_record)).role.id !== "reviewer") continue;
        const payload = payloadView.safeParse(JSON.parse(row.payload));
        if (!payload.success) continue;
        return {
          verdict:
            row.kind === "step.succeeded" && payload.data.result.status === "succeeded"
              ? "pass"
              : "fail",
          headSha: payload.data.result.revision.headSha,
        };
      }
      return undefined;
    },
  };
}
