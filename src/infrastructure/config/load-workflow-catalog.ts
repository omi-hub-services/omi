import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { workflowSchema } from "../../application/contracts/workflow.js";
import type { PinnedWorkflow, WorkflowCatalog } from "../../application/ports/workflow-catalog.js";
import { loadWorkflowTemplate } from "./load-workflow-template.js";

/**
 * Loads the named workflow templates through the shared strict loader and pins each by the
 * sha-256 of its bytes. A template that does not load or validate fails the whole catalog, so a
 * run can never start from a half-valid template set.
 */
export async function loadWorkflowCatalog(
  directory: string,
  ids: readonly string[],
): Promise<WorkflowCatalog> {
  const byId = new Map<string, PinnedWorkflow>();
  for (const id of ids) {
    const text = await loadWorkflowTemplate(directory, id);
    const workflow = workflowSchema.parse(
      parseDocument(text, { uniqueKeys: true, customTags: [], schema: "core" }).toJS({
        maxAliasCount: 0,
      }),
    );
    byId.set(id, { workflow, hash: createHash("sha256").update(text).digest("hex") });
  }
  return {
    byId: (id) => byId.get(id),
    byHash: (hash) => [...byId.values()].find((pinned) => pinned.hash === hash),
  };
}
