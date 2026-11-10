import { describe, expect, it } from "vitest";
import { commandSchema } from "../../../../src/application/contracts/command.ts";
import { contextPacketSchema } from "../../../../src/application/contracts/context.ts";
import { modelsConfigSchema } from "../../../../src/application/contracts/model-capability.ts";
import { projectConfigSchema } from "../../../../src/application/contracts/project-config.ts";
import { stepResultSchema } from "../../../../src/application/contracts/result.ts";
import { workflowSchema } from "../../../../src/application/contracts/workflow.ts";

const SHA256 = "a".repeat(64);
const GIT_SHA = "b".repeat(40);

const validModels = {
  schema_version: 1,
  models: {
    "sonnet-5-5": {
      executor: "claude-code",
      model: "claude-sonnet-5-5",
      supported_efforts: ["low", "medium", "high"],
    },
    "opus-5-5": {
      executor: "claude-code",
      model: "claude-opus-5-5",
      supported_efforts: ["medium", "high", "xhigh", "max"],
    },
  },
  capability_profiles: { analysis: { min_effort: "high" }, coding: { min_effort: "medium" } },
  verified_models: { analysis: ["opus-5-5"], coding: ["sonnet-5-5", "opus-5-5"] },
};

const validWorkflow = {
  schema_version: 1,
  id: "feature",
  version: 1,
  selection: { task_types: ["feature"] },
  quality_policy: "task-default",
  steps: [
    {
      id: "analyze",
      role: "analyst",
      needs: [],
      skills: ["requirements-analysis"],
      capability_profile: "analysis",
      output_contract: "analysis-result-v1",
    },
    {
      id: "implement",
      role: "developer",
      needs: ["analyze"],
      capability_profile: "coding",
      output_contract: "implementation-result-v1",
    },
  ],
  gates: [{ id: "scope-approved", before: "implement", policy: "approved-business-baseline" }],
};

const validProjectConfig = {
  schema_version: 1,
  repository: { owner: "omi-hub-services", name: "omi" },
  project: { owner: "omi-hub-services", number: 1 },
  branches: { integration: "develop", release: "main" },
  limits: { max_parallel_workers: 3, step_timeout_seconds: 3600, max_rework_cycles: 2 },
  policies: { mandatory_approvals: ["release"] },
};

const validContext = {
  schemaVersion: 1,
  runId: "run-1",
  stepId: "implement",
  attemptId: "attempt-1",
  taskSnapshot: { issueNumber: 9, title: "Contract/schema v1", body: "text" },
  acceptanceCriteria: ["rejects bad input"],
  businessBaselineHash: SHA256,
  role: "developer",
  capabilityProfile: { id: "coding", min_effort: "medium" },
  workspace: { path: "/home/user/work/omi-007" },
  inputArtifacts: [{ path: "reports/analysis.md", sha256: SHA256 }],
  skillsManifest: [{ id: "implementation", version: "1", sha256: SHA256 }],
  rulesManifest: [],
  previousFindings: [],
  expectedOutputSchema: "implementation-result-v1",
  allowedScope: { paths: ["src/application/contracts"] },
  approvalRefs: [],
};

const validResult = {
  schemaVersion: 1,
  runId: "run-1",
  stepId: "implement",
  attemptId: "attempt-1",
  status: "succeeded",
  summary: "done",
  artifacts: [{ path: "reports/implementation.md", sha256: SHA256 }],
  revision: { headSha: GIT_SHA, baseSha: GIT_SHA },
  checks: [{ id: "unit-tests", evidenceRef: "checks/unit.json" }],
  findings: [],
  nextAction: "verify",
};

const validCommand = { schemaVersion: 1, command: "dispatch", runId: "run-1", stepId: "implement" };

describe("valid input parses", () => {
  it.each([
    ["models", modelsConfigSchema, validModels],
    ["workflow", workflowSchema, validWorkflow],
    ["project config", projectConfigSchema, validProjectConfig],
    ["context packet", contextPacketSchema, validContext],
    ["step result", stepResultSchema, validResult],
    ["command", commandSchema, validCommand],
  ])("%s", (_name, schema, input) => {
    expect(schema.safeParse(input).success).toBe(true);
  });

  it("applies workflow defaults for skills, rules and gates", () => {
    const parsed = workflowSchema.parse({ ...validWorkflow, gates: undefined });
    expect(parsed.gates).toEqual([]);
    expect(parsed.steps[1]?.skills).toEqual([]);
  });
});

describe("wrong schema version is rejected", () => {
  it.each([
    ["models", modelsConfigSchema, { ...validModels, schema_version: 2 }],
    ["workflow", workflowSchema, { ...validWorkflow, schema_version: "1" }],
    ["project config", projectConfigSchema, { ...validProjectConfig, schema_version: 0 }],
    ["context packet", contextPacketSchema, { ...validContext, schemaVersion: 2 }],
    ["step result", stepResultSchema, { ...validResult, schemaVersion: undefined }],
    ["command", commandSchema, { ...validCommand, schemaVersion: 2 }],
  ])("%s", (_name, schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

describe("unknown fields are rejected", () => {
  it.each([
    ["dispatch", validCommand],
    ["pause", { schemaVersion: 1, command: "pause", runId: "run-1", reason: "quota" }],
    ["resume", { schemaVersion: 1, command: "resume", runId: "run-1" }],
    ["wait", { schemaVersion: 1, command: "wait", runId: "run-1", timeoutSeconds: 30 }],
    ["status", { schemaVersion: 1, command: "status" }],
    ["plan", { schemaVersion: 1, command: "plan", issueNumber: 9 }],
  ])("in command %s", (_name, command) => {
    expect(commandSchema.safeParse(command).success).toBe(true);
    const result = commandSchema.safeParse({ ...command, approved: true });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown command", () => {
    expect(
      commandSchema.safeParse({ schemaVersion: 1, command: "merge", runId: "r" }).success,
    ).toBe(false);
  });

  it("rejects a credential field in models config", () => {
    const withKey = {
      ...validModels,
      models: {
        ...validModels.models,
        "sonnet-5-5": { ...validModels.models["sonnet-5-5"], api_key: "sk-secret" },
      },
    };
    expect(modelsConfigSchema.safeParse(withKey).success).toBe(false);
    expect(modelsConfigSchema.safeParse({ ...validModels, token: "x" }).success).toBe(false);
  });

  it("rejects extra fields in context, result and project config", () => {
    expect(contextPacketSchema.safeParse({ ...validContext, extra: 1 }).success).toBe(false);
    expect(stepResultSchema.safeParse({ ...validResult, extra: 1 }).success).toBe(false);
    expect(projectConfigSchema.safeParse({ ...validProjectConfig, extra: 1 }).success).toBe(false);
  });
});

describe("effort and model validation", () => {
  it("rejects an unknown effort in a capability profile", () => {
    const bad = { ...validModels, capability_profiles: { analysis: { min_effort: "ultra" } } };
    expect(modelsConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown effort in a model's supported efforts", () => {
    const bad = structuredClone(validModels);
    bad.models["sonnet-5-5"].supported_efforts = ["turbo"];
    expect(modelsConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty or repeating supported effort list", () => {
    const empty = structuredClone(validModels);
    empty.models["sonnet-5-5"].supported_efforts = [];
    expect(modelsConfigSchema.safeParse(empty).success).toBe(false);
    const repeated = structuredClone(validModels);
    repeated.models["sonnet-5-5"].supported_efforts = ["low", "low"];
    expect(modelsConfigSchema.safeParse(repeated).success).toBe(false);
  });

  it("rejects an unknown executor and a model name with shell characters", () => {
    const executor = structuredClone(validModels);
    executor.models["sonnet-5-5"].executor = "gemini";
    expect(modelsConfigSchema.safeParse(executor).success).toBe(false);
    const model = structuredClone(validModels);
    model.models["sonnet-5-5"].model = "x; rm -rf /";
    expect(modelsConfigSchema.safeParse(model).success).toBe(false);
  });

  it("rejects a verified model that is undeclared, or whose efforts are all below the profile", () => {
    const unknownAlias = { ...validModels, verified_models: { analysis: ["ghost"] } };
    expect(modelsConfigSchema.safeParse(unknownAlias).success).toBe(false);
    // sonnet-5-5 tops out at "high"; a profile needing "xhigh" cannot be verified on it.
    const tooWeak = {
      ...validModels,
      capability_profiles: { analysis: { min_effort: "xhigh" } },
      verified_models: { analysis: ["sonnet-5-5"] },
    };
    expect(modelsConfigSchema.safeParse(tooWeak).success).toBe(false);
  });

  it("rejects verified models for an undeclared profile", () => {
    const bad = { ...validModels, verified_models: { ghost: ["opus-5-5"] } };
    expect(modelsConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a context packet whose capability profile lacks or misstates min_effort", () => {
    expect(
      contextPacketSchema.safeParse({ ...validContext, capabilityProfile: { id: "coding" } })
        .success,
    ).toBe(false);
    expect(
      contextPacketSchema.safeParse({
        ...validContext,
        capabilityProfile: { id: "coding", min_effort: "extreme" },
      }).success,
    ).toBe(false);
  });
});

describe("other invalid input is rejected", () => {
  it("rejects duplicate step ids, unknown needs and unknown gate targets", () => {
    const [analyze, implement] = validWorkflow.steps;
    const dup = { ...validWorkflow, steps: [analyze, { ...implement, id: "analyze" }] };
    expect(workflowSchema.safeParse(dup).success).toBe(false);

    const needs = { ...validWorkflow, steps: [analyze, { ...implement, needs: ["ghost"] }] };
    expect(workflowSchema.safeParse(needs).success).toBe(false);

    const gate = { ...validWorkflow, gates: [{ id: "g", before: "ghost", policy: "p" }] };
    expect(workflowSchema.safeParse(gate).success).toBe(false);
  });

  it("rejects a gate with both or neither of before/after, and a workflow without steps", () => {
    const both = {
      ...validWorkflow,
      gates: [{ id: "g", before: "analyze", after: "implement", policy: "p" }],
    };
    expect(workflowSchema.safeParse(both).success).toBe(false);
    const neither = { ...validWorkflow, gates: [{ id: "g", policy: "p" }] };
    expect(workflowSchema.safeParse(neither).success).toBe(false);
    expect(workflowSchema.safeParse({ ...validWorkflow, steps: [] }).success).toBe(false);
  });

  it("rejects paths that escape the workspace or run directory", () => {
    for (const path of ["/etc/passwd", "../secret", "a/../../b", "a\\b"]) {
      expect(
        stepResultSchema.safeParse({ ...validResult, artifacts: [{ path, sha256: SHA256 }] })
          .success,
        path,
      ).toBe(false);
    }
    expect(
      contextPacketSchema.safeParse({ ...validContext, allowedScope: { paths: ["../x"] } }).success,
    ).toBe(false);
    expect(
      contextPacketSchema.safeParse({ ...validContext, workspace: { path: "relative/dir" } })
        .success,
    ).toBe(false);
  });

  it("rejects malformed hashes, statuses and out-of-range command fields", () => {
    expect(
      stepResultSchema.safeParse({
        ...validResult,
        artifacts: [{ path: "a.md", sha256: "xyz" }],
      }).success,
    ).toBe(false);
    expect(stepResultSchema.safeParse({ ...validResult, status: "done" }).success).toBe(false);
    expect(
      stepResultSchema.safeParse({ ...validResult, revision: { headSha: "abc", baseSha: GIT_SHA } })
        .success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ schemaVersion: 1, command: "wait", runId: "r", timeoutSeconds: 0 })
        .success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ schemaVersion: 1, command: "plan", issueNumber: -1 }).success,
    ).toBe(false);
  });

  it("rejects non-object input and missing required fields", () => {
    expect(commandSchema.safeParse("dispatch").success).toBe(false);
    expect(workflowSchema.safeParse(null).success).toBe(false);
    expect(projectConfigSchema.safeParse({ schema_version: 1 }).success).toBe(false);
  });
});
