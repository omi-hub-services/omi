import type { CheckRunRecord } from "../contracts/check-run.js";

/** Passed check results the runtime may reuse, kept in run state so a restart does not lose them. */
export interface CheckResultStore {
  /** The newest saved result for exactly this check id, revision and command. */
  find(checkId: string, revision: string, command: readonly string[]): CheckRunRecord | undefined;
  save(record: CheckRunRecord): void;
}
