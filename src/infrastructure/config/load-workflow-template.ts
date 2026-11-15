import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfigYaml } from "./config-diagnostics.js";
import { ZodError } from "zod";
import { slugSchema } from "../../application/contracts/identifiers.js";
import { workflowSchema } from "../../application/contracts/workflow.js";
import { ProjectInitializationError } from "../../application/ports/github-project-reader.js";

/** Shared strict loader for framework workflow templates; returns their original bytes. */
export async function loadWorkflowTemplate(directory: string, id: string): Promise<string> {
  if (!slugSchema.safeParse(id).success)
    throw new ProjectInitializationError("INVALID_WORKFLOW_TEMPLATE");
  const text = await readFile(join(directory, `${id}.yaml`), "utf8");
  try {
    const workflow = workflowSchema.parse(parseConfigYaml(text));
    if (workflow.id !== id)
      throw new ZodError([
        { code: "custom", path: ["id"], message: "id must match the workflow filename" },
      ]);
  } catch (cause) {
    throw Object.assign(new ProjectInitializationError("INVALID_WORKFLOW_TEMPLATE"), { cause });
  }
  return text;
}
