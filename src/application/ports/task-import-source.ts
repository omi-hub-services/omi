import type { ProjectConfig } from "../contracts/project-config.js";

/** Resolve configured Project and selected repository Issues without writing GitHub. */
export interface TaskImportSource {
  resolve(
    config: ProjectConfig,
    issueNumbers: readonly number[],
  ): Promise<{
    readonly projectId: string;
    readonly issueIds: readonly string[];
  }>;
}

/** Runtime-owned project identity; returns nothing when the writer lease is lost. */
export interface TaskImportProjectStore {
  ensure(repository: string, remoteProjectId: string, configHash: string): string | undefined;
}
