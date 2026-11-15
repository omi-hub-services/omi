/**
 * Result of a policy gate: allowed, or refused with every failed reason code. `reason` is the
 * highest-priority refusal (the first one the policy lists), `reasons` is the full set so the
 * Coordinator can tell the PO everything that blocks, not one thing at a time.
 */
export type Decision<R extends string> =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: R; readonly reasons: readonly [R, ...R[]] };

export const ALLOWED: Decision<never> = { allowed: true };

/** Builds a decision from the refusals found, in priority order. */
export function decide<R extends string>(refusals: readonly R[]): Decision<R> {
  const [first, ...rest] = refusals;
  if (first === undefined) {
    return ALLOWED;
  }
  return { allowed: false, reason: first, reasons: [first, ...rest] };
}
