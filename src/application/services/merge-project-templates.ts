import type { TemplateFiles } from "../contracts/project-installation.js";

/** Whole-file three-way merge. Divergent edits require a person; deletions count as edits. */
export function mergeProjectTemplates(
  base: TemplateFiles,
  incoming: TemplateFiles,
  local: TemplateFiles,
) {
  const merged: TemplateFiles = {};
  const conflicts: string[] = [];
  const changes: string[] = [];
  for (const path of new Set([
    ...Object.keys(base),
    ...Object.keys(incoming),
    ...Object.keys(local),
  ])) {
    const before = base[path];
    const next = incoming[path];
    const current = local[path];
    let value = current;
    if (current === before) value = next;
    else if (next !== before && current !== next) conflicts.push(path);
    if (value !== undefined) merged[path] = value;
    if (value !== current) changes.push(path);
  }
  return { merged, conflicts: conflicts.sort(), changes: changes.sort() };
}
