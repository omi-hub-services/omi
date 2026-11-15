import type { CodebaseDetection, OnboardingVariant } from "../contracts/project-onboarding.js";

export const ONBOARDING_PATHS = {
  config: ".omi-squad/config/project.yaml",
  codebase: ".omi-squad/config/codebase.yaml",
  plan: ".omi-squad/config/onboarding-plan.md",
  workflow: (variant: OnboardingVariant): string =>
    `.omi-squad/workflows/onboarding-${variant === "new" ? "empty-repo" : "takeover"}.yaml`,
} as const;

/** JSON scalars are valid YAML, so quoting through JSON.stringify keeps repository text inert. */
const scalar = (value: string): string => JSON.stringify(value);
const list = (values: readonly string[]): string => `[${values.map(scalar).join(", ")}]`;

/** `.omi-squad/config/codebase.yaml`: detected facts only, deterministic for a given input. */
export function renderCodebaseConfig(detection: CodebaseDetection): string {
  const commands = Object.entries(detection.commands)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, command]) => `  ${name}: ${scalar(command)}`);
  return [
    "schema_version: 1",
    `language: ${scalar(detection.language)}`,
    `other_languages: ${list(detection.other_languages)}`,
    ...(detection.package_manager === undefined
      ? []
      : [`package_manager: ${scalar(detection.package_manager)}`]),
    ...(commands.length === 0 ? ["commands: {}"] : ["commands:", ...commands]),
    `evidence: ${list(detection.evidence)}`,
    "",
  ].join("\n");
}

/** Human-readable plan; a missing fact is called out as work for the Analyst, never invented. */
export function renderOnboardingPlan(
  variant: OnboardingVariant,
  detection: CodebaseDetection,
): string {
  const { test, build, lint } = detection.commands;
  const lines = [
    `# Onboarding plan (${variant === "new" ? "new project" : "existing project"})`,
    "",
    `Workflow: \`${ONBOARDING_PATHS.workflow(variant)}\``,
    "",
    "## Detected",
    "",
    `- Language: ${detection.language}`,
    `- Package manager: ${detection.package_manager ?? "unknown"}`,
    `- Test command: ${test === undefined ? "not detected" : `\`${test}\``}`,
    `- Build command: ${build === undefined ? "not detected" : `\`${build}\``}`,
    `- Lint command: ${lint === undefined ? "not detected" : `\`${lint}\``}`,
    "",
    "## Next steps",
    "",
  ];
  if (variant === "new") {
    lines.push(
      "1. Review `project.yaml`: repository, Project mapping, branches and limits.",
      "2. Run the `onboarding-empty-repo` workflow to choose the stack and the first verifiable task.",
    );
    if (detection.language !== "unknown") {
      lines.push(
        `3. The repository is not empty (${detection.evidence.join(", ")}); consider the existing-project variant.`,
      );
    }
  } else {
    lines.push(
      "1. Review `project.yaml` and `codebase.yaml`; correct anything detection got wrong.",
      test === undefined
        ? "2. No test command was detected: the Analyst records how the project is verified before any change."
        : `2. Run \`${test}\` once and record the baseline result before any change.`,
      "3. Run the `onboarding-takeover` workflow to map architecture, risks and first tasks.",
    );
  }
  lines.push(
    "",
    "Existing files are never overwritten; rerun after editing to see what is kept.",
    "",
  );
  return lines.join("\n");
}
