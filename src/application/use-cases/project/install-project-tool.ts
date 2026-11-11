import { installationInputSchema } from "../../contracts/project-installation.js";
import type { ProjectInstallation } from "../../ports/project-installation.js";
import { mergeProjectTemplates } from "../../services/merge-project-templates.js";

/** Installs or updates one project. Conflicts and previews have no installation side effects. */
export async function installProjectTool(store: ProjectInstallation, raw: unknown) {
  const input = installationInputSchema.parse(raw);
  const snapshot = await store.inspect(input);
  if (
    snapshot.installed !== undefined &&
    (snapshot.installed.projectDir !== input.projectDir ||
      snapshot.installed.distribution !== input.distribution)
  )
    throw new Error("PROJECT_BINDING_CHANGED");
  const merge = mergeProjectTemplates(
    snapshot.installed?.base ?? {},
    snapshot.candidate.base,
    snapshot.local,
  );
  const result = {
    version: snapshot.candidate.version,
    conflicts: merge.conflicts,
    changes: merge.changes,
  };
  if (merge.conflicts.length > 0) return { ...result, status: "conflict" as const };
  if (!input.apply) return { ...result, status: "preview" as const };
  const applied = await store.apply({ ...snapshot, input, merged: merge.merged });
  return { ...result, ...applied, status: "installed" as const };
}
