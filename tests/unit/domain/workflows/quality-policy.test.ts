import { expect, it } from "vitest";
import * as policy from "../../../../src/domain/workflows/workflow-policy.ts";

const input = {
  qualityPolicy: "task-default",
  complexity: "medium" as const,
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

it.each(["task-default", "lean"])(
  "adds risk focus without changing worker count for %s",
  (qualityPolicy) => {
    expect(policy).toHaveProperty("resolveQualityPolicy", expect.any(Function));
    for (const complexity of ["low", "medium"] as const)
      expect(policy.resolveQualityPolicy({ ...input, qualityPolicy, complexity })).toMatchObject({
        reviewFocus: [],
      });
  },
);
it.each(["task-default", "lean", "strict", "unknown", "bounded-rework"])(
  "keeps independent review and SHA checks for %s",
  (qualityPolicy) => {
    expect(policy.resolveQualityPolicy({ ...input, qualityPolicy })).toMatchObject({
      independentReview: true,
      exactShaCheck: true,
    });
    expect(policy.resolveQualityPolicy({ ...input, qualityPolicy })).not.toHaveProperty(
      "combineVerifyReview",
    );
    for (const risk of ["security", "gates", "data"] as const)
      expect(
        policy.resolveQualityPolicy({
          ...input,
          qualityPolicy,
          risks: { ...input.risks, [risk]: true },
        }).reviewFocus,
      ).toContain(risk);
  },
);
it("strict and unknown policies retain independent review", () => {
  for (const qualityPolicy of ["strict", "unknown"])
    expect(policy.resolveQualityPolicy({ ...input, qualityPolicy }).independentReview).toBe(true);
});
it("skips analysis only with measurable AC, a map and a recorded approval of the Issue", () => {
  expect(policy.resolveQualityPolicy(input)).toMatchObject({
    skipAnalyze: true,
    scopeEvidence: "issue:190",
  });
  for (const scope of [
    undefined,
    { ...input.scope, measurableAc: false },
    { ...input.scope, implementationMap: false },
    { ...input.scope, approvalRef: "" },
  ])
    expect(policy.resolveQualityPolicy({ ...input, scope }).skipAnalyze).toBe(false);
});
it.each([
  ["analyze", 1, "medium"],
  ["review", 1, "medium"],
  ["verify", 1, "low"],
  ["review", 2, "low"],
  ["verify", 2, "low"],
  ["implement", 1, "high"],
])("assigns effort to %s round %s", (step, round, effort) => {
  expect(policy.resolveQualityPolicy({ ...input, complexity: "high", step, round }).effort).toBe(
    effort,
  );
});
it("limits repeated quality work to delta plus previous verdict", () => {
  expect(policy.resolveQualityPolicy({ ...input, round: 2 }).reviewScope).toBe(
    "delta-with-previous-verdict",
  );
  expect(policy.resolveQualityPolicy(input).reviewScope).toBe("full");
});

it("resolves legacy Project Workflow options to templates or gated delivery use cases", () => {
  expect(policy).toHaveProperty("resolveWorkflowRoute", expect.any(Function));
  expect(policy.resolveWorkflowRoute("init")).toEqual({
    kind: "template",
    id: "onboarding-takeover",
  });
  expect(policy.resolveWorkflowRoute("research")).toEqual({
    kind: "template",
    id: "idea-to-issues",
  });
  expect(policy.resolveWorkflowRoute("release")).toEqual({
    kind: "delivery",
    id: "prepare-release",
  });
  expect(policy.resolveWorkflowRoute("deploy")).toEqual({ kind: "delivery", id: "deploy-release" });
  expect(
    policy.workflowOptionIssues(
      ["init", "feature", "release", "deploy"],
      ["onboarding-takeover", "feature"],
    ),
  ).toEqual([]);
  expect(policy.workflowOptionIssues(["unmapped", "research"], ["feature"])).toEqual([
    "unmapped: missing template unmapped",
    "research: missing template idea-to-issues",
  ]);
});

it("keeps custom developer effort and capability floors above cost savings", () => {
  const task = {
    workflow: "feature",
    workType: "task",
    area: "tooling",
    priority: "P1",
    acCount: 1,
    labels: [],
    complexity: "high" as const,
  };
  const mapping = { low: "low" as const, medium: "medium" as const, high: "max" as const };
  expect(
    policy.resolveWorkflowEffort(task, mapping, "low", {
      policy: "lean",
      step: "implement",
      round: 1,
    }).minEffort,
  ).toBe("max");
  expect(
    policy.resolveWorkflowEffort(task, mapping, "high", {
      policy: "lean",
      step: "review",
      round: 1,
    }).minEffort,
  ).toBe("high");
});
it("treats broad scope as unknown risk and recognizes sensitive changed paths", () => {
  expect(policy.workflowRisks(["src"])).toEqual({ security: true, gates: true, data: true });
  expect(policy.workflowRisks(["src/interfaces/cli/commands/task.ts"])).toEqual({
    security: false,
    gates: false,
    data: false,
  });
  expect(policy.workflowRisks(["src/auth/session.ts"]).security).toBe(true);
  expect(policy.workflowRisks(["rules/approval.md"]).gates).toBe(true);
  expect(policy.workflowRisks(["migrations/0001-schema.sql"]).data).toBe(true);
});
it.each([
  "src/infrastructure/process/exec-runner.ts",
  "src/infrastructure/process/spawn-worker.ts",
  "tools/coordinator/shell-command.ts",
  "src/infrastructure/github/token-scope.ts",
  "src/domain/permission/grant.ts",
  "src/domain/approvals/approval-request.ts",
])("marks %s as security risk", (path) => {
  expect(policy.workflowRisks([path]).security).toBe(true);
});
it("adds security-review to the review step skills only when the security risk is set", () => {
  const security = { security: true, gates: false, data: false };
  const none = { security: false, gates: false, data: false };
  expect(policy.resolveQualityPolicy({ ...input, risks: security }).reviewSkills).toEqual([
    "security-review",
  ]);
  expect(policy.resolveQualityPolicy({ ...input, risks: none }).reviewSkills).toEqual([]);
  expect(
    policy.resolveQualityPolicy({ ...input, step: "verify", risks: security }).reviewSkills,
  ).toEqual([]);
  expect(policy.dispatchSkills("review", ["independent-review"], 1, security)).toEqual([
    "independent-review",
    "security-review",
  ]);
  expect(policy.dispatchSkills("review", ["independent-review"], 1, none)).toEqual([
    "independent-review",
  ]);
  expect(policy.dispatchSkills("implement", ["minimal-change"], 1, security)).toEqual([
    "minimal-change",
  ]);
  expect(
    policy.dispatchSkills("review", ["independent-review", "security-review"], 2, security),
  ).toEqual(["independent-review", "security-review"]);
});
