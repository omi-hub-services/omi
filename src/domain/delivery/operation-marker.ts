/**
 * Logical operation marker (architecture.md §11): a line of text that the adapter writes into the
 * body of every remote Issue, PR or comment it creates, so a later read-back can tell whether an
 * operation whose response was lost already took effect. A local unique key alone cannot do this.
 *
 * The marker is data written by whoever can edit the remote text. It is evidence for
 * de-duplication only and never an authorisation or an approval (AGENTS.md §3).
 */

/**
 * Keys are stable, human-readable intents such as `create-pr:<repo>:<task>:<branch>:develop`
 * (design-patterns.md §7). The character set keeps the marker inside one HTML comment; `--`
 * would close a comment early in strict HTML, so it is refused.
 */
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/#-]{0,199}$/;

export function isValidOperationKey(key: string): boolean {
  return OPERATION_KEY.test(key) && !key.includes("--");
}

/** The exact marker text for an operation key. Throws `RangeError` for an invalid key. */
export function operationMarker(operationKey: string): string {
  if (!isValidOperationKey(operationKey)) {
    throw new RangeError(
      "operation key must be 1-200 chars of A-Z a-z 0-9 . _ : @ / # - without --",
    );
  }
  return `<!-- omi-squad:operation:${operationKey} -->`;
}

/**
 * True when `text` contains the marker of exactly this key. The marker ends with a delimiter, so
 * the key `a:1` never matches the marker of `a:12`.
 */
export function hasOperationMarker(text: string, operationKey: string): boolean {
  return text.includes(operationMarker(operationKey));
}
