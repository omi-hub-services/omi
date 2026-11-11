import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { slugSchema } from "../../application/contracts/identifiers.js";
import { workflowSchema } from "../../application/contracts/workflow.js";
import { ProjectInitializationError } from "../../application/ports/github-project-reader.js";

/** Shared strict loader for framework workflow templates; returns their original bytes. */
export async function loadWorkflowTemplate(directory: string, id: string): Promise<string> {
  if (!slugSchema.safeParse(id).success)
    throw new ProjectInitializationError("INVALID_WORKFLOW_TEMPLATE");
  const text = await readFile(join(directory, `${id}.yaml`), "utf8");
  const document = parseDocument(text, { uniqueKeys: true, customTags: [], schema: "core" });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new ProjectInitializationError("INVALID_WORKFLOW_TEMPLATE");
  const parsed = workflowSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!parsed.success || parsed.data.id !== id)
    throw new ProjectInitializationError("INVALID_WORKFLOW_TEMPLATE");
  return text;
}
