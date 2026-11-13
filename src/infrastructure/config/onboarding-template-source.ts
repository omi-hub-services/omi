import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { OnboardingTemplateSource } from "../../application/ports/onboarding-file-store.js";
import { loadWorkflowTemplate } from "./load-workflow-template.js";

const TEMPLATE_IDS = {
  new: "onboarding-empty-repo",
  existing: "onboarding-takeover",
} as const;

/** `directory` is `templates/project/workflows` of the installed framework. */
export function createOnboardingTemplateSource(directory: string): OnboardingTemplateSource {
  return {
    async runtimeFiles() {
      const root = resolve(directory, "..");
      const files: { path: string; content: string }[] = [];
      for (const folder of [".omi-squad", "workflows"]) {
        const entries = await readdir(join(root, folder), { recursive: true, withFileTypes: true });
        for (const entry of entries.filter(
          (entry) => entry.isFile() && entry.name !== ".gitkeep",
        )) {
          const absolute = join(entry.parentPath, entry.name);
          const path = absolute.slice(join(root, folder).length + 1);
          files.push({
            path: folder === "workflows" ? `.omi-squad/workflows/${path}` : `.omi-squad/${path}`,
            content: await readFile(absolute, "utf8"),
          });
        }
      }
      return files.sort((a, b) => a.path.localeCompare(b.path));
    },
    workflow: (variant) => loadWorkflowTemplate(directory, TEMPLATE_IDS[variant]),
  };
}
