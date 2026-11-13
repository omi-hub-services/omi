import type { OnboardingVariant } from "../contracts/project-onboarding.js";

/** Pinned to a target repository root by bootstrap. Paths are relative and never from Issue text. */
export interface OnboardingFileStore {
  exists(path: string): Promise<boolean>;
  /** Atomic create-only publication: an existing path (including a symlink) is preserved. */
  create(path: string, content: string): Promise<"created" | "exists">;
}

/** Supplies the already schema-validated workflow template text for a variant. */
export interface OnboardingTemplateSource {
  runtimeFiles(): Promise<readonly { path: string; content: string }[]>;
  workflow(variant: OnboardingVariant): Promise<string>;
}
