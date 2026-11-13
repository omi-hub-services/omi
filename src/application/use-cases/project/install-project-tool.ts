import {
  installationInputSchema,
  releaseInstallationInputSchema,
} from "../../contracts/project-installation.js";
import type { ProjectInstallation } from "../../ports/project-installation.js";
import type { ReleasePackage } from "../../ports/release-package.js";
import { releaseUpdateNotes } from "../../services/release-update-notes.js";
import { mergeProjectTemplates } from "../../services/merge-project-templates.js";

/** Installs or updates one project. Conflicts and previews have no installation side effects. */
export async function installProjectTool(
  store: ProjectInstallation,
  raw: unknown,
  releases?: ReleasePackage,
) {
  const releaseInput = releaseInstallationInputSchema.safeParse(raw);
  if (releaseInput.success) {
    if (releases === undefined) throw new Error("RELEASE_DOWNLOAD_NOT_WIRED");
    const input = releaseInput.data;
    const release = await releases.prepare(input.version);
    try {
      return await installPackage(
        store,
        {
          projectDir: input.projectDir,
          distribution: input.distribution,
          packageDir: release.packageDir,
          apply: input.apply,
        },
        { ...input, changelog: release.changelog },
      );
    } finally {
      await release.cleanup();
    }
  }
  return installPackage(store, raw);
}

async function installPackage(
  store: ProjectInstallation,
  raw: unknown,
  release?: {
    version: string;
    changelog: string;
    acceptBreaking: boolean;
  },
) {
  const input = installationInputSchema.parse(raw);
  const snapshot = await store.inspect(input);
  if (
    snapshot.installed !== undefined &&
    (snapshot.installed.projectDir !== input.projectDir ||
      snapshot.installed.distribution !== input.distribution)
  )
    throw new Error("PROJECT_BINDING_CHANGED");
  let notes = { changelog: "", breaking: false };
  if (release !== undefined) {
    if (snapshot.installed === undefined) throw new Error("UPDATE_REQUIRES_INSTALLATION");
    if (snapshot.candidate.version !== release.version) throw new Error("RELEASE_VERSION_MISMATCH");
    notes = releaseUpdateNotes(release.changelog, snapshot.installed.version, release.version);
    if (input.apply && notes.breaking && !release.acceptBreaking)
      throw new Error(
        `BREAKING_CHANGES_REQUIRE_ACCEPTANCE: use --accept-breaking\n${notes.changelog}`,
      );
  }
  const merge = mergeProjectTemplates(
    snapshot.installed?.base ?? {},
    snapshot.candidate.base,
    snapshot.local,
  );
  const result = {
    ...notes,
    version: snapshot.candidate.version,
    conflicts: merge.conflicts,
    changes: merge.changes,
  };
  if (merge.conflicts.length > 0) return { ...result, status: "conflict" as const };
  if (!input.apply) return { ...result, status: "preview" as const };
  const applied = await store.apply({ ...snapshot, input, merged: merge.merged });
  return { ...result, ...applied, status: "installed" as const };
}
