import { z } from "zod";
import { workflowSchema } from "../../contracts/workflow.js";
import { identifierSchema } from "../../contracts/identifiers.js";
import { assertCredentialFree } from "../../contracts/credential-input.js";
import type { ArtifactReference } from "../../contracts/artifact.js";
import type { ApprovalStore, ApprovalSubjectReader } from "../../ports/approval-store.js";
import { checkExecutionApprovals } from "../../services/check-execution-approvals.js";
import {
  dispatchStep,
  type DispatchStepDependencies,
  type DispatchStepInput,
  type DispatchStepResult,
} from "./dispatch-step.js";

const preparationSchema = z.strictObject({
  workflow: workflowSchema.refine((workflow) => ["ui-ux", "ci-cd"].includes(workflow.id)),
  ui: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("present") }),
    z.strictObject({ status: z.literal("absent"), reason: z.string().trim().min(1).max(2000) }),
    z.strictObject({ status: z.literal("unknown") }),
  ]),
  cost: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("none") }),
    z.strictObject({ status: z.literal("unknown") }),
    z.strictObject({
      status: z.literal("new"),
      approvalId: identifierSchema,
      subjectId: identifierSchema,
    }),
  ]),
});

export interface SpecialistStepDependencies extends DispatchStepDependencies {
  readonly approvals: ApprovalStore;
  readonly subjects: ApprovalSubjectReader;
  readonly allowedPoActors: readonly string[];
  readonly authorActor: string;
}

export type SpecialistStepResult =
  | DispatchStepResult
  | { readonly ok: true; readonly skipped: true; readonly evidence: ArtifactReference }
  | {
      readonly ok: false;
      readonly reason: "UI_APPLICABILITY_UNKNOWN" | "COST_UNKNOWN" | "COST_APPROVAL_REQUIRED";
    };

/**
 * Trusted Coordinator entrypoint for UI/UX and CI/CD steps. Call for EVERY dispatch with current
 * project applicability and cost assessment, never worker-supplied claims. It deliberately does
 * not infer cost from Issue prose or let worker JSON manufacture an approval. Generic dispatch
 * remains available to other workflows; callers must route these templates through this boundary.
 */
export async function dispatchSpecialistStep(
  deps: SpecialistStepDependencies,
  preparation: unknown,
  input: DispatchStepInput,
): Promise<SpecialistStepResult> {
  const parsed = preparationSchema.safeParse(preparation);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const { workflow, ui, cost } = parsed.data;
  const row = deps.steps.get(input.stepRunId);
  const step = workflow.steps.find((candidate) => candidate.id === row?.stepId);
  if (row === undefined || step === undefined) return { ok: false, reason: "INVALID_INPUT" };
  if (row.status !== "ready") return { ok: false, reason: "STEP_NOT_READY" };

  if (workflow.id === "ui-ux") {
    if (ui.status === "unknown") return { ok: false, reason: "UI_APPLICABILITY_UNKNOWN" };
    if (ui.status === "absent") {
      const record = {
        schemaVersion: 1,
        runId: row.runId,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        status: "skipped",
        reason: ui.reason,
      };
      assertCredentialFree(record);
      const id = deps.nextId();
      const evidence = deps.artifacts.write({
        id,
        path: `workflow-decisions/${id}.json`,
        bytes: new TextEncoder().encode(JSON.stringify(record)),
        classification: "workflow-skip",
        createdAt: new Date(deps.now()).toISOString(),
      });
      return { ok: true, skipped: true, evidence };
    }
  }

  if (cost.status === "unknown") return { ok: false, reason: "COST_UNKNOWN" };
  if (cost.status === "new") {
    const decision = checkExecutionApprovals(
      { store: deps.approvals, subjects: deps.subjects, now: deps.now },
      [{ approvalId: cost.approvalId, subjectId: cost.subjectId, kind: "cost" }],
      deps.allowedPoActors,
      deps.authorActor,
    );
    if (!decision.allowed) return { ok: false, reason: "COST_APPROVAL_REQUIRED" };
  }

  // Existing result verification checks these ids and verifies the referenced artifact bytes.
  // Do not permit a template edit to silently remove its specialist evidence or cost gate.
  const evidencePolicy = workflow.id === "ci-cd" ? "pipeline-output" : "visual-evidence";
  const expectedChecks =
    step.id === "verify"
      ? [evidencePolicy]
      : workflow.id === "ui-ux" && step.id === "design"
        ? ["design-evidence"]
        : [];
  if (
    !workflow.gates.some((gate) => gate.before === step.id && gate.policy === "approved-cost") ||
    !expectedChecks.every((policy) =>
      workflow.gates.some((gate) => gate.after === step.id && gate.policy === policy),
    )
  )
    return { ok: false, reason: "MANDATORY_GATE_MISSING" };

  return dispatchStep(deps, {
    ...input,
    role: step.role,
    stepSkills: step.skills,
    stepRules: step.rules,
    requiredChecks: [...new Set([...(input.requiredChecks ?? []), ...expectedChecks])],
    context: {
      ...input.context,
      capabilityProfile: {
        ...input.context.capabilityProfile,
        id: step.capability_profile,
      },
      expectedOutputSchema: step.output_contract,
    },
  });
}
