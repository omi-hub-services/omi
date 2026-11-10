// Minimal boundary validation for gh JSON output (AGENTS.md §3). A shape mismatch throws with
// the path, so a changed GitHub API fails loudly instead of producing a wrong status.

export type JsonObject = Readonly<Record<string, unknown>>;

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${what}: output is not JSON`);
  }
}

export function asObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path}: expected an object`);
  }
  return value as JsonObject;
}

export function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected an array`);
  return value;
}

export function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path}: expected a string`);
  return value;
}

export function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number") throw new Error(`${path}: expected a number`);
  return value;
}

export function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path}: expected a boolean`);
  return value;
}

export const optString = (value: unknown, path: string): string | null =>
  value === null || value === undefined ? null : asString(value, path);

export const optObject = (value: unknown, path: string): JsonObject | null =>
  value === null || value === undefined ? null : asObject(value, path);

/** Reads `obj.key.nodes` of a GraphQL connection. */
export function nodes(obj: JsonObject, key: string, path: string): readonly unknown[] {
  return asArray(asObject(obj[key], `${path}.${key}`).nodes, `${path}.${key}.nodes`);
}

/** Throws on a GraphQL `errors` array; returns `data`. */
export function graphqlData(text: string, what: string): JsonObject {
  const root = asObject(parseJson(text, what), what);
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    const first = asObject(root.errors[0], `${what}.errors[0]`);
    throw new Error(`${what}: GraphQL error: ${String(first.message)}`);
  }
  return asObject(root.data, `${what}.data`);
}
