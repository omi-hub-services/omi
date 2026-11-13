import type { z } from "zod";
import type { stepQualitySchema } from "../contracts/workflow.js";

/** Shared instructions for repository and installed-runtime packets. */
export function renderQualityInstructions(quality: z.infer<typeof stepQualitySchema>): string {
  const qualityWorker = quality.step === "verify" || quality.step === "review";
  return [
    `Workflow packet: ${quality.steps.join(" + ")} · round ${String(quality.round)} · policy ${quality.policy}`,
    ...(qualityWorker
      ? [
          "Use one fresh independent worker, with no author session or shared author context.",
          "QA judges the supplied script-run check evidence; do not rerun tests.",
          "Review and check evidence must refer to the exact revision SHA. Missing evidence blocks the verdict.",
          ...(quality.round > 1
            ? [
                "Judge only the delta since the previous verdict, together with that verdict and the new script-run check evidence. Missing previous verdict or delta blocks the verdict.",
              ]
            : []),
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
