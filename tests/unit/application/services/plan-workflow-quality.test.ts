import { expect, it } from "vitest";
import { workflowSchema } from "../../../../src/application/contracts/workflow.ts";
import * as quality from "../../../../src/application/services/plan-workflow-quality.ts";

const step = (id: string, needs: string[], role = id) => ({
  id,
  needs,
  role,
  skills: [id],
  rules: ["project-baseline"],
  capability_profile: id,
  output_contract: "step-result",
});
const workflow = workflowSchema.parse({
  schema_version: 1,
  id: "feature",
  version: 1,
  selection: { task_types: ["feature"] },
  quality_policy: "task-default",
  steps: [
    step("analyze", []),
    step("implement", ["analyze"], "developer"),
    step("verify", ["implement"], "qa"),
    step("review", ["verify"], "reviewer"),
  ],
  gates: [
    { id: "scope-approved", before: "implement", policy: "approved-business-baseline" },
    { id: "ready-to-merge", after: "review", policy: "develop-merge" },
  ],
});
const facts = {
  qualityPolicy: "task-default",
  complexity: "low" as const,
  step: "review",
  round: 1,
  risks: { security: false, gates: false, data: false },
  scope: {
    measurableAc: true,
    implementationMap: true,
    issueRef: "issue:190",
    approvalRef: "approval-1",
  },
};
it("projects one independent review worker with both original step packets and all gates", () => {
  expect(quality).toHaveProperty("planWorkflowQuality", expect.any(Function));
  const plan = quality.planWorkflowQuality(workflow, facts);
  expect(plan.workflow.steps.map((s) => s.id)).toEqual(["implement", "review"]);
  expect(plan.workflow.steps[0]?.needs).toEqual([]);
  expect(plan.workflow.steps[1]).toMatchObject({
    role: "reviewer",
    needs: ["implement"],
    skills: ["verify", "review"],
  });
  expect(plan.packets.review?.map((s) => s.id)).toEqual(["verify", "review"]);
  expect(plan.workflow.gates).toEqual(workflow.gates);
  expect(plan.scopeEvidence).toBe("issue:190");
});
it("keeps an intermediate approval/evidence gate between verify and review", () => {
  const gated = {
    ...workflow,
    gates: [...workflow.gates, { id: "qa-approved", after: "verify", policy: "qa-approval" }],
  };
  expect(quality.planWorkflowQuality(gated, facts).workflow.steps.map((s) => s.id)).toContain(
    "verify",
  );
});
it("keeps high risk work separate and never takes scope approval from Issue text", () => {
  const plan = quality.planWorkflowQuality(workflow, {
    ...facts,
    scope: undefined,
    risks: { ...facts.risks, gates: true },
  });
  expect(plan.workflow.steps.map((s) => s.id)).toEqual([
    "analyze",
    "implement",
    "verify",
    "review",
  ]);
});

it("combines documentation acceptance by reviewer role while preserving its step id", () => {
  const docs = {
    ...workflow,
    id: "docs",
    steps: workflow.steps.map((s) => (s.id === "review" ? { ...s, id: "accept" } : s)),
    gates: [],
  };
  const plan = quality.planWorkflowQuality(docs, facts);
  expect(plan.workflow.steps.map((s) => s.id)).toEqual(["implement", "accept"]);
  expect(plan.packets.accept?.map((s) => s.id)).toEqual(["verify", "accept"]);
});

it("keeps every combined step's verified models and effort floor", () => {
  expect(quality).toHaveProperty("packetModels", expect.any(Function));
  const models = {
    schema_version: 1 as const,
    models: {
      weak: { executor: "codex" as const, model: "weak", supported_efforts: ["medium" as const] },
      strong: { executor: "codex" as const, model: "strong", supported_efforts: ["high" as const] },
    },
    capability_profiles: {
      verify: { min_effort: "high" as const },
      review: { min_effort: "medium" as const },
    },
    verified_models: { verify: ["strong"], review: ["weak", "strong"] },
  };
  const result = quality.packetModels(
    models,
    [workflow.steps[2], workflow.steps[3]].filter((s) => s !== undefined),
    "review",
  );
  expect(result.capability_profiles.review).toMatchObject({ min_effort: "high" });
  expect(result.verified_models.review).toEqual(["strong"]);
});

it("preserves prerequisites when approved analysis is omitted", () => {
  const dependent = workflowSchema.parse({
    ...workflow,
    steps: [
      step("design", []),
      ...workflow.steps.map((s) => (s.id === "analyze" ? { ...s, needs: ["design"] } : s)),
    ],
  });
  const plan = quality.planWorkflowQuality(dependent, facts);
  expect(plan.workflow.steps.find((s) => s.id === "implement")?.needs).toEqual(["design"]);
});
