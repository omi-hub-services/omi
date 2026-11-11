import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { workflowSchema } from "../../application/contracts/workflow.js";
import { ProjectInitializationError } from "../../application/ports/github-project-reader.js";
import type { OnboardingTemplateSource } from "../../application/ports/onboarding-file-store.js";

const TEMPLATE_FILES = {
  new: "onboarding-empty-repo.yaml",
  existing: "onboarding-takeover.yaml",
} as const;

/**
 * `directory` is `templates/project/workflows` of the installed framework. Every template is
 * parsed and validated against the workflow contract before it can be written to a project.
 */
export function createOnboardingTemplateSource(directory: string): OnboardingTemplateSource {
  return {
    async workflow(variant) {
      const text = await readFile(join(directory, TEMPLATE_FILES[variant]), "utf8");
      const document = parseDocument(text, { uniqueKeys: true, customTags: [], schema: "core" });
      if (document.errors.length > 0 || document.warnings.length > 0)
        throw new ProjectInitializationError("INVALID_WORKFLOW_TEMPLATE");
      if (!workflowSchema.safeParse(document.toJS({ maxAliasCount: 0 })).success)
        throw new ProjectInitializationError("INVALID_WORKFLOW_TEMPLATE");
      return text;
    },
  };
}
