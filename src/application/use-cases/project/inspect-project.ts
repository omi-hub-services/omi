import {
  inspectedProjectSchema,
  projectLocatorSchema,
} from "../../contracts/project-initialization.js";
import type { InspectedProject } from "../../contracts/project-initialization.js";
import { ProjectInitializationError } from "../../ports/github-project-reader.js";
import type { GithubProjectReader } from "../../ports/github-project-reader.js";

/** Read-only discovery; names are display metadata and never select fields or options. */
export async function inspectProject(
  reader: GithubProjectReader,
  input: unknown,
): Promise<InspectedProject> {
  const locator = projectLocatorSchema.parse(input);
  const project = inspectedProjectSchema.parse(await reader.inspect(locator));
  if (
    project.number !== locator.number ||
    project.owner.login.toLowerCase() !== locator.owner.toLowerCase()
  ) {
    throw new ProjectInitializationError("PROJECT_IDENTITY_MISMATCH");
  }
  const ids = project.fields.map((f) => f.id);
  if (
    new Set(ids).size !== ids.length ||
    project.fields.some((f) => new Set(f.options.map((o) => o.id)).size !== f.options.length)
  ) {
    throw new ProjectInitializationError("DUPLICATE_REMOTE_IDS");
  }
  return project;
}
