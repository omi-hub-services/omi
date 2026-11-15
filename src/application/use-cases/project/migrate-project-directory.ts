import { installationInputSchema } from "../../contracts/project-installation.js";
import type { ProjectDirectoryMigration } from "../../ports/project-directory-migration.js";

export async function migrateProjectDirectory(migrate: ProjectDirectoryMigration, raw: unknown) {
  const input = installationInputSchema.pick({ projectDir: true }).parse(raw);
  return migrate(input.projectDir);
}
