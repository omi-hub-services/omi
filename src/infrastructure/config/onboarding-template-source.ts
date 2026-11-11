import type { OnboardingTemplateSource } from "../../application/ports/onboarding-file-store.js";
import { loadWorkflowTemplate } from "./load-workflow-template.js";

const TEMPLATE_IDS = {
  new: "onboarding-empty-repo",
  existing: "onboarding-takeover",
} as const;

/** `directory` is `templates/project/workflows` of the installed framework. */
export function createOnboardingTemplateSource(directory: string): OnboardingTemplateSource {
  return {
    workflow: (variant) => loadWorkflowTemplate(directory, TEMPLATE_IDS[variant]),
  };
}
