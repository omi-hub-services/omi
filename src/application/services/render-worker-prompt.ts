import {
  reviewRiskSkills,
  workflowReviewFocus,
  type QualityPolicyInput,
} from "../../domain/workflows/workflow-policy.js";
import { workerPromptAssets } from "./worker-prompt-assets.js";
import type { z } from "zod";
import type { stepQualitySchema } from "../contracts/workflow.js";

/** A security-relevant review is refused without this section (review-comment and the runtime gate). */
const SECURITY_SECTION_INSTRUCTION =
  "Security-relevant change: apply the security-review skill. Your result must contain a section that starts with the line `Security:`; under it, one line per checklist area of that skill saying `checked` or `no findings`, each with its evidence (file:line, command or case). A security defect is a must-fix finding. A review without this section is refused.";

/** Shared instructions for repository and installed-runtime packets. */
export function renderQualityInstructions(
  quality: z.infer<typeof stepQualitySchema>,
  deltaReview: boolean = quality.round > 1,
  risks?: QualityPolicyInput["risks"],
): string {
  const qualityWorker = quality.step === "verify" || quality.step === "review";
  return [
    `Workflow packet: ${quality.steps.join(" + ")} · round ${String(quality.round)} · policy ${quality.policy}`,
    ...(qualityWorker
      ? [
          workerPromptAssets.qualityWorker,
          ...(quality.step === "review" &&
          risks !== undefined &&
          workflowReviewFocus(risks).length > 0
            ? [`Review focus: ${workflowReviewFocus(risks).join(", ")}`]
            : []),
          ...(reviewRiskSkills(quality.step, risks).length > 0
            ? [SECURITY_SECTION_INSTRUCTION]
            : []),
          ...(deltaReview ? [workerPromptAssets.qualityDelta] : []),
        ]
      : []),
  ].join("\n");
}

const SLOT_NAMES = [
  "identity",
  "workspace",
  "read_first",
  "task_context",
  "notes",
  "skills",
  "rules",
  "restrictions",
  "report_contract",
] as const;

export type WorkerPromptSlots = Readonly<Record<(typeof SLOT_NAMES)[number], string>>;

/** Validate the skeleton first; substituted task data is never interpreted as template syntax. */
export function renderWorkerPrompt(skeleton: string, slots: WorkerPromptSlots): string {
  const seen = new Set<string>();
  const remainder = skeleton.replace(/\{\{([a-z_]+)\}\}/g, (_match, name: string) => {
    if (!SLOT_NAMES.some((slot) => slot === name)) throw new Error(`unknown prompt slot: ${name}`);
    seen.add(name);
    return "";
  });
  if (remainder.includes("{{") || remainder.includes("}}")) {
    throw new Error("malformed prompt slot");
  }
  for (const name of SLOT_NAMES) {
    if (!seen.has(name) || typeof slots[name] !== "string") {
      throw new Error(`missing prompt slot: ${name}`);
    }
  }
  return skeleton.replace(
    /\{\{([a-z_]+)\}\}/g,
    (_match, name: keyof WorkerPromptSlots) => slots[name],
  );
}
