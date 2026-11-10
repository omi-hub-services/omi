import type { RuntimeStatus } from "../../contracts/runtime-status.js";
import { CONTRACT_SCHEMA_VERSION } from "../../contracts/schema-version.js";

/** Facts fixed when the runtime starts; bootstrap supplies them (no hidden clock or file read). */
export interface RuntimeIdentity {
  readonly runtimeVersion: string;
  /** ISO-8601 UTC start time. */
  readonly startedAt: string;
}

/**
 * Answers the Coordinator's `status` command for the runtime itself. Run/step status needs a
 * read port and arrives with the Issue that owns it; this proves the CLI → IPC → use case path.
 */
export function inspectRuntime(identity: RuntimeIdentity): RuntimeStatus {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    state: "ready",
    runtimeVersion: identity.runtimeVersion,
    startedAt: identity.startedAt,
  };
}
