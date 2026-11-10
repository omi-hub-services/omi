/**
 * Lease resource keys. A lease row is keyed by resource, so a key admits exactly one holder:
 * building the key here keeps "one active writer per worktree" in one place.
 */
export function worktreeLeaseKey(worktreeId: string): string {
  if (worktreeId.trim() === "") {
    throw new RangeError("worktree id must not be empty");
  }
  return `worktree:${worktreeId}`;
}
