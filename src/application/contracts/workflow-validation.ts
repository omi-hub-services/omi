import type { ResolutionCatalog } from "./resolution-catalog.js";
import type { Workflow } from "./workflow.js";
import type { Role } from "./role.js";

export interface ConfigValidationError {
  readonly file: string;
  readonly path: string;
  readonly message: string;
}

export interface WorkflowValidationResult {
  readonly ok: boolean;
  readonly errors: readonly ConfigValidationError[];
}

export interface WorkflowValidationCatalog {
  readonly catalog: ResolutionCatalog;
  readonly roles: readonly { file: string; definition: Role }[];
  readonly workflows: readonly { file: string; workflow: Workflow }[];
  readonly errors: readonly ConfigValidationError[];
}
