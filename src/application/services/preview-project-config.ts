import type { ProjectConfig } from "../contracts/project-config.js";

export interface ConfigChange {
  readonly path: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

/** Deterministic leaf diff; arrays are one value, object keys are sorted. No YAML formatting noise. */
export function previewProjectConfig(
  before: ProjectConfig | undefined,
  after: ProjectConfig,
): ConfigChange[] {
  const changes: ConfigChange[] = [];
  function visit(left: unknown, right: unknown, path: string): void {
    const object = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    if ((left === undefined || object(left)) && object(right)) {
      const previous = object(left) ? left : {};
      for (const key of [...new Set([...Object.keys(previous), ...Object.keys(right)])].sort()) {
        visit(previous[key], right[key], path === "" ? key : `${path}.${key}`);
      }
    } else if (JSON.stringify(left) !== JSON.stringify(right)) {
      changes.push({
        path,
        ...(left === undefined ? {} : { before: left }),
        ...(right === undefined ? {} : { after: right }),
      });
    }
  }
  visit(before, after, "");
  return changes;
}
