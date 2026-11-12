import { z } from "zod";
import type { StateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";

const lease = z.object({ expires_at: z.string() });

/**
 * A release (project owner or workspace writer) stores `expires_at` = the release time. If the
 * wall clock then steps back (WSL2 steps it back 1-2 s about every 30 s), the next claim still
 * sees an unexpired lease and refuses with PROJECT_OWNER_HELD or WRITER_HELD. Call this after a
 * release and before the next claim so a test measures the product, not the clock. A lease far in
 * the future is a real holder, not a clock step, so it is not waited for.
 */
export async function waitForClockPastLease(db: StateDatabase): Promise<void> {
  const times = db
    .prepare("SELECT expires_at FROM leases")
    .all()
    .map((row) => Date.parse(lease.parse(row).expires_at))
    .filter((time) => time - Date.now() <= 10_000);
  const until = Math.max(0, ...times);
  while (Date.now() <= until) await new Promise<void>((resolve) => setTimeout(resolve, 25));
}
