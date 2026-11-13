import { sha256ContentHasher } from "../artifacts/sha256-content-hasher.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { modelsConfigSchema } from "../../application/contracts/model-capability.js";
import { assertCredentialFree } from "../../application/contracts/credential-input.js";
import { createProjectConfigStore } from "./project-config-store.js";
import { loadWorkflowCatalog } from "./load-workflow-catalog.js";
import { loadResolutionCatalog } from "./load-resolution-catalog.js";
import { configDiagnostics } from "./config-diagnostics.js";
import type { Workflow } from "../../application/contracts/workflow.js";
import type { CatalogRole } from "../../application/contracts/resolution-catalog.js";
import type {
  ConfigValidationError,
  WorkflowValidationCatalog,
} from "../../application/contracts/workflow-validation.js";

/** Loads installed workflow assets without project settings, state, models or IPC. */
export async function loadWorkflowValidationCatalog(
  squadDir: string,
): Promise<WorkflowValidationCatalog> {
  const errors: ConfigValidationError[] = [];
  const roleFiles = new Map<CatalogRole, string>();
  const catalog = loadResolutionCatalog(squadDir, errors, roleFiles);
  const roles = [...roleFiles].map(([role, file]) => ({ definition: role.definition, file }));
  const workflows: {
    file: string;
    workflow: Workflow;
  }[] = [];
  const directory = join(squadDir, "workflows");
  let files: string[];
  try {
    files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    errors.push(...configDiagnostics(directory, error));
    return { catalog, roles, workflows, errors };
  }
  for (const name of files) {
    const file = join(directory, name);
    try {
      const id = name.slice(0, -5);
      const loaded = await loadWorkflowCatalog(directory, [id]);
      const workflow = loaded.byId(id)?.workflow;
      if (workflow === undefined) throw new Error("Workflow unavailable");
      workflows.push({ file, workflow });
    } catch (error) {
      errors.push(...configDiagnostics(file, error));
    }
  }
  return { catalog, roles, workflows, errors };
}

export async function loadRuntimeConfig(squadDir: string) {
  const project = await (await createProjectConfigStore(join(squadDir, "config"))).read();
  if (project === undefined) throw new Error("PROJECT_NOT_CONFIGURED");
  const document = parseDocument(readFileSync(join(squadDir, "config", "models.yaml"), "utf8"), {
    uniqueKeys: true,
    customTags: [],
    schema: "core",
  });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new Error("INVALID_MODELS_CONFIG");
  const raw: unknown = document.toJS({ maxAliasCount: 0 });
  // Same guard project.yaml gets: a credential-shaped file fails by code before any issue text exists.
  assertCredentialFree(raw);
  const models = modelsConfigSchema.parse(raw);
  const ids = readdirSync(join(squadDir, "workflows"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name.slice(0, -5));
  return {
    project,
    models,
    workflows: await loadWorkflowCatalog(join(squadDir, "workflows"), ids),
    catalog: loadResolutionCatalog(squadDir),
  };
}

/** The runtime project revision includes parsed defaults and the verified resolution catalog. */
export function runtimeConfigHash(config: Awaited<ReturnType<typeof loadRuntimeConfig>>): string {
  return sha256ContentHasher.sha256(
    JSON.stringify({ project: config.project, models: config.models, catalog: config.catalog }),
  );
}
