import { projectConfigSchema } from "../../contracts/project-config.js";
import type { ProjectConfig } from "../../contracts/project-config.js";
import {
  initializeProjectSchema,
  projectOwnerSchema,
} from "../../contracts/project-initialization.js";
import type { InspectedProject } from "../../contracts/project-initialization.js";
import { ProjectInitializationError } from "../../ports/github-project-reader.js";
import type { GithubProjectReader } from "../../ports/github-project-reader.js";
import type { ProjectConfigStore } from "../../ports/project-config-store.js";
import { previewProjectConfig } from "../../services/preview-project-config.js";
import type { ConfigChange } from "../../services/preview-project-config.js";
import { queueProjectTemplate } from "../../services/queue-project-template.js";
import type { ProjectTemplateQueueDeps } from "../../services/queue-project-template.js";
import { inspectProject } from "./inspect-project.js";

export interface InitializeProjectDeps {
  readonly github: GithubProjectReader;
  readonly config: ProjectConfigStore;
  /** Required only to apply a template; runtime supplies its durable outbox dependencies. */
  readonly templateQueue?: ProjectTemplateQueueDeps;
}

export type InitializeProjectResult =
  | {
      readonly kind: "mapping";
      readonly status: "preview" | "applied" | "config-exists";
      readonly project: InspectedProject;
      readonly proposed: ProjectConfig;
      readonly changes: readonly ConfigChange[];
    }
  | {
      readonly kind: "template";
      readonly status: "preview" | "queued" | "config-exists";
      readonly template: InspectedProject;
      readonly operation: {
        readonly type: "project.copy";
        readonly sourceProjectId: string;
        readonly ownerId: string;
        readonly title: string;
      };
      readonly operationKey: string;
      readonly queue?: { state: string; remoteIdentity: string | null };
      readonly next: "inspect-copy-and-map-ids";
    };

/** Preview by default. Existing config is a merge proposal only, even with apply=true. */
export async function initializeProject(
  deps: InitializeProjectDeps,
  input: unknown,
): Promise<InitializeProjectResult> {
  const request = initializeProjectSchema.parse(input);
  const current = await deps.config.read();
  const existing = current === undefined ? undefined : projectConfigSchema.parse(current);
  if (request.source.kind === "template") {
    const source = request.source;
    const template = await inspectProject(deps.github, source.template);
    const owner = projectOwnerSchema.parse(await deps.github.owner(source.owner));
    if (owner.login.toLowerCase() !== source.owner.toLowerCase())
      throw new ProjectInitializationError("OWNER_IDENTITY_MISMATCH");
    const operation = {
      type: "project.copy" as const,
      sourceProjectId: template.id,
      ownerId: owner.id,
      title: source.title,
    };
    const base = {
      kind: "template" as const,
      template,
      operation,
      operationKey: source.operationKey,
      next: "inspect-copy-and-map-ids" as const,
    };
    if (existing !== undefined) return { ...base, status: "config-exists" };
    if (!request.apply) return { ...base, status: "preview" };
    if (deps.templateQueue === undefined)
      throw new ProjectInitializationError("TEMPLATE_QUEUE_REQUIRED");
    return {
      ...base,
      status: "queued",
      queue: queueProjectTemplate(deps.templateQueue, source.operationKey, operation),
    };
  }

  const source = request.source;
  const project = await inspectProject(deps.github, source.project);
  const used = new Set<string>();
  for (const selected of Object.values(source.fields)) {
    const field = project.fields.find((candidate) => candidate.id === selected.field_id);
    if (field === undefined) throw new ProjectInitializationError("FIELD_NOT_FOUND");
    if (used.has(field.id)) throw new ProjectInitializationError("DUPLICATE_FIELD_MAPPING");
    used.add(field.id);
    if (field.dataType !== selected.data_type)
      throw new ProjectInitializationError("FIELD_TYPE_MISMATCH");
    const options = Object.values(selected.options);
    if (options.length > 0 && field.dataType !== "SINGLE_SELECT")
      throw new ProjectInitializationError("OPTIONS_REQUIRE_SINGLE_SELECT");
    if (new Set(options).size !== options.length)
      throw new ProjectInitializationError("DUPLICATE_OPTION_MAPPING");
    if (options.some((id) => !field.options.some((option) => option.id === id)))
      throw new ProjectInitializationError("OPTION_NOT_FOUND");
  }
  const previousFields =
    existing?.project.mapping?.id === project.id ? existing.project.mapping.fields : {};
  const proposed = projectConfigSchema.parse({
    ...(existing ?? request.config),
    project: {
      owner: project.owner.login,
      number: project.number,
      mapping: {
        id: project.id,
        owner_type: project.owner.type,
        fields: { ...previousFields, ...source.fields },
      },
    },
  });
  const changes = previewProjectConfig(existing, proposed);
  const base = { kind: "mapping" as const, project, proposed, changes };
  if (existing !== undefined) return { ...base, status: "config-exists" };
  if (!request.apply) return { ...base, status: "preview" };
  const written = await deps.config.create(proposed);
  return { ...base, status: written === "created" ? "applied" : "config-exists" };
}
