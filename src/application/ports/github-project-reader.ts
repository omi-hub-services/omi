import type {
  InspectedProject,
  ProjectLocator,
  ProjectOwner,
} from "../contracts/project-initialization.js";

export class ProjectInitializationError extends Error {
  override readonly name = "ProjectInitializationError";
  readonly code: string;
  constructor(code: string) {
    super(`Project initialization failed: ${code}`);
    this.code = code;
  }
}

/** Full, validated snapshots only. Failed or incomplete pagination must throw, never truncate. */
export interface GithubProjectReader {
  inspect(project: ProjectLocator): Promise<InspectedProject>;
  owner(login: string): Promise<ProjectOwner>;
}
