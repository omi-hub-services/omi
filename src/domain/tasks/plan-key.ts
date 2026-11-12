const MARKER_SOURCE = String.raw`<!--\s*omi-squad:plan-key=([A-Z][A-Z0-9]*-\d+)\s*-->`;

/** The task key shape the project allocates: a prefix and three digits, e.g. `OMI-079`. */
export const PLAN_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d{3}$/;

/** Hidden body marker that ties an Issue to its Project Plan Key. */
export function planKeyMarker(key: string): string {
  return `<!-- omi-squad:plan-key=${key} -->`;
}

/** Every Plan Key marker in a body, in order. A new RegExp per call keeps no global state. */
export function planKeyMarkers(body: string): string[] {
  return [...body.matchAll(new RegExp(MARKER_SOURCE, "g"))].map((match) => match[1] ?? "");
}

/** Largest allocated `PREFIX-NNN` plus one; keys of another prefix or shape do not count. */
export function nextPlanKey(prefix: string, allocated: readonly (string | null)[]): string {
  const pattern = new RegExp(`^${prefix}-(\\d{3})$`);
  const highest = allocated.reduce((max, key) => {
    const match = pattern.exec(key ?? "");
    return match === null ? max : Math.max(max, Number(match[1]));
  }, 0);
  if (highest >= 999) throw new Error(`${prefix}-NNN Plan Key space exhausted`);
  return `${prefix}-${String(highest + 1).padStart(3, "0")}`;
}
