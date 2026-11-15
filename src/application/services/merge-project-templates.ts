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
    const before = base[path]?.replaceAll("\r\n", "\n");
    const next = incoming[path]?.replaceAll("\r\n", "\n");
    const current = local[path];
    const normalizedCurrent = current?.replaceAll("\r\n", "\n");
    let value = current;
    // Keep unchanged checkout bytes; materialize actual template changes with LF.
    if (normalizedCurrent === before && normalizedCurrent !== next) value = next;
    else if (next !== before && normalizedCurrent !== next) conflicts.push(path);
    if (value !== undefined) merged[path] = value;
    if (value !== current) changes.push(path);
  }
  return { merged, conflicts: conflicts.sort(), changes: changes.sort() };
}
