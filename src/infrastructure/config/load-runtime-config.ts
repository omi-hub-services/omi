import { sha256ContentHasher } from "../artifacts/sha256-content-hasher.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { modelsConfigSchema } from "../../application/contracts/model-capability.js";
import { assertCredentialFree } from "../../application/contracts/credential-input.js";
import { createProjectConfigStore } from "./project-config-store.js";
import { loadWorkflowCatalog } from "./load-workflow-catalog.js";
import { loadResolutionCatalog } from "./load-resolution-catalog.js";

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
