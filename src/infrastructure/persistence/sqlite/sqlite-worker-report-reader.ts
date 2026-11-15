import { z } from "zod";
import type { WorkerReportReader } from "../../../application/ports/worker-report-reader.js";
import type { StateDatabase } from "./sqlite-connection.js";

export function createSqliteWorkerReportReader(db: StateDatabase): WorkerReportReader {
  const read = db.prepare(
    "SELECT payload FROM events WHERE correlation_id = ? AND kind IN ('step.succeeded', 'step.failed') ORDER BY sequence DESC LIMIT 1",
  );
  return {
    read(attemptId) {
      const row = read.get(attemptId);
      return row === undefined
        ? undefined
        : (JSON.parse(z.object({ payload: z.string() }).parse(row).payload) as unknown);
    },
  };
}
