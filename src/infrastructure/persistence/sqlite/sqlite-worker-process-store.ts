import { z } from "zod";
import type { LeaseFence } from "../../../application/ports/state-unit-of-work.js";
import type { WorkerProcessStore } from "../../../application/ports/run-recovery.js";
import type { StateDatabase } from "./sqlite-connection.js";
import { runInTransaction } from "./sqlite-transaction.js";

const referenceSchema = z.strictObject({
  pid: z.number().int().positive(),
  startIdentity: z.string().regex(/^[0-9a-f-]{36}:\d+$/),
  generation: z.number().int().positive(),
});

/** Uses the process identity columns from migration 0001; no second state file or PID lock.
 * The start identity encodes boot id + kernel start ticks, rather than wall-clock approximations.
 */
export function createSqliteWorkerProcessStore(
  db: StateDatabase,
  options: {
    fence: LeaseFence;
    now(): number;
  },
): WorkerProcessStore {
  const read = db.prepare(
    "SELECT process_pid AS pid, process_started_at AS startIdentity, process_generation AS generation FROM agent_attempts WHERE id = ? AND process_pid IS NOT NULL",
  );
  const lease = db.prepare(
    "SELECT 1 FROM leases WHERE resource_key = ? AND owner = ? AND generation = ? AND expires_at > ?",
  );
  const write =
    db.prepare(`UPDATE agent_attempts SET process_pid = ?, process_started_at = ?, process_generation = ?
    WHERE id = ? AND status IN ('pending', 'running') AND process_pid IS NULL`);
  return {
    reference(attemptId) {
      const row = read.get(attemptId);
      return row === undefined ? undefined : referenceSchema.parse(row);
    },
    saveReference(attempt, input) {
      const reference = referenceSchema.parse(input);
      if (reference.generation !== attempt.workspace.generation)
        throw new Error("STALE_PROCESS_GENERATION");
      runInTransaction(db, () => {
        const at = new Date(options.now()).toISOString();
        const fence = options.fence;
        if (
          lease.get(fence.resourceKey, fence.owner, fence.generation, at) === undefined ||
          lease.get(
            attempt.workspace.leaseKey,
            attempt.workspace.owner,
            attempt.workspace.generation,
            at,
          ) === undefined
        )
          throw new Error("STALE_LEASE");
        if (
          write.run(reference.pid, reference.startIdentity, reference.generation, attempt.id)
            .changes !== 1
        )
          throw new Error("PROCESS_REFERENCE_REJECTED");
      });
    },
  };
}
