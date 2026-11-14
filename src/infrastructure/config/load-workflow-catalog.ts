import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { workflowSchema } from "../../application/contracts/workflow.js";
import type { PinnedWorkflow, WorkflowCatalog } from "../../application/ports/workflow-catalog.js";
import { loadWorkflowTemplate } from "./load-workflow-template.js";
import { archiveWorkflowTemplate, readWorkflowArchive } from "./workflow-template-archive.js";
import { resolveWorkflowRoute } from "../../domain/workflows/workflow-policy.js";

function pin(text: string): PinnedWorkflow {
  const workflow = workflowSchema.parse(
    parseDocument(text, { uniqueKeys: true, customTags: [], schema: "core" }).toJS({
      maxAliasCount: 0,
    }),
  );
  return { workflow, hash: createHash("sha256").update(text).digest("hex") };
}

/**
 * Loads the named workflow templates through the shared strict loader and pins each by the
 * sha-256 of its bytes. A template that does not load or validate fails the whole catalog, so a
 * run can never start from a half-valid template set.
 *
 * With `archive`, a run keeps the template it pinned after an update replaces the installed file:
 * `byHash` looks at the installed templates first, then at the content-addressed archive under
 * `localDir` (also seeded from install backups). `persist` lets the runtime write the installed
 * templates and backup templates into it; read-only observers leave it untouched. An archived
 * template that no longer validates is skipped, so its run gets TEMPLATE_UNAVAILABLE.
 */
export async function loadWorkflowCatalog(
  directory: string,
  ids: readonly string[],
  archive?: { readonly localDir: string; readonly persist: boolean },
): Promise<WorkflowCatalog> {
  const byId = new Map<string, PinnedWorkflow>();
  for (const id of ids) {
    const text = await loadWorkflowTemplate(directory, id);
    byId.set(id, pin(text));
    if (archive?.persist === true) await archiveWorkflowTemplate(archive.localDir, text);
  }
  const archived = new Map<string, PinnedWorkflow>();
  if (archive !== undefined) {
    for (const text of await readWorkflowArchive(archive.localDir, archive.persist)) {
      try {
        const pinned = pin(text);
        archived.set(pinned.hash, pinned);
      } catch {
        // Skipped on purpose: an invalid archived template must not stop the runtime.
      }
    }
  }
  return {
    byId: (id) => {
      const route = resolveWorkflowRoute(id);
      return route.kind === "template" ? byId.get(route.id) : undefined;
    },
    byHash: (hash) =>
      [...byId.values()].find((pinned) => pinned.hash === hash) ?? archived.get(hash),
  };
}
