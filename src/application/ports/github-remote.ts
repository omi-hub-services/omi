import type { GithubOperation } from "../contracts/github-operation.js";

/**
 * What one send attempt told us about the remote. The categories are the ones the outbox state
 * machine needs, and they never mix: `rejected_*` means the remote answered and applied nothing,
 * `outcome_unknown` means the effect may exist. An adapter that cannot tell the two apart MUST
 * answer `outcome_unknown`; guessing "nothing happened" is how a retry creates a duplicate.
 *
 * `code` is a short stable identifier (for example `RATE_LIMITED`, `HTTP_422`, `TIMEOUT`), never
 * text taken from the remote.
 */
export type SendOutcome =
  | { readonly kind: "succeeded"; readonly remoteIdentity: string }
  | {
      readonly kind: "rejected_retryable";
      readonly code: string;
      /** The remote's own wait (Retry-After, rate-limit reset) in ms, when it gave one. */
      readonly retryAfterMs?: number;
    }
  | { readonly kind: "rejected_final"; readonly code: string }
  | { readonly kind: "outcome_unknown"; readonly code: string };

/**
 * What a read-back found. `absent` is only returned after the remote's listing was read to the
 * end; a listing that could not be completed is `unavailable`, never `absent`.
 */
export type LookupOutcome =
  | { readonly kind: "found"; readonly remoteIdentity: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable"; readonly code: string };

export interface LookupRequest {
  readonly operation: GithubOperation;
  /** Operation key; the adapter derives the marker text from it (domain `operationMarker`). */
  readonly operationKey: string;
  /** ISO-8601 UTC time the intent was recorded; the remote effect cannot be older. */
  readonly notBefore: string;
}

export interface SendRequest {
  readonly operation: GithubOperation;
  readonly operationKey: string;
}

/**
 * The GitHub side effects the outbox can perform, and the read-back that finds them again.
 * Adapters report remote failures as outcomes and do not throw for them; a thrown error means a
 * programming fault and is treated by the use cases as an unknown outcome.
 */
export interface GithubRemote {
  /** Performs the operation once, with its logical marker embedded in the remote text. */
  send(request: SendRequest): Promise<SendOutcome>;
  /** Looks for the operation's marker on the remote (the reconciliation read-back). */
  lookup(request: LookupRequest): Promise<LookupOutcome>;
}
