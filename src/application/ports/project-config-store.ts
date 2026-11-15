import type { ProjectConfig } from "../contracts/project-config.js";

/** Pinned to a target config directory by bootstrap, never an input path from Issue text. */
export interface ProjectConfigStore {
  read(): Promise<ProjectConfig | undefined>;
  /** Atomic create-only publication: an existing path (including a symlink) must be preserved. */
  create(config: ProjectConfig): Promise<"created" | "exists">;
}
