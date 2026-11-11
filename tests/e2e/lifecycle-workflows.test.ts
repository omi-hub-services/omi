import { parse } from "yaml";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { workflowSchema, type Workflow } from "../../src/application/contracts/workflow.ts";
import { dispatchStep } from "../../src/application/use-cases/runs/dispatch-step.ts";
import { recordStepResult } from "../../src/application/use-cases/runs/record-step-result.ts";
import {
  evaluateRunCompletion,
  evaluateStepStartability,
  validateWorkflowGraph,
  type GateStatus,
} from "../../src/domain/workflows/workflow-policy.ts";
import type { StepStatus } from "../../src/domain/runs/step-run.ts";
import { loadWorkflowTemplate } from "../../src/infrastructure/config/load-workflow-template.ts";
import { loadResolutionCatalog } from "../../src/infrastructure/config/load-resolution-catalog.ts";
import {
  BASE,
  HEAD,
  dispatchInput,
  rig,
  type Rig,
} from "../unit/application/use-cases/runs/run-fakes.ts";

const directory = resolve(import.meta.dirname, "../../templates/project/workflows");
const catalog = loadResolutionCatalog(resolve(directory, "../.omi-squad"));
const ids = ["feature", "bugfix", "refactor", "docs"] as const;
type Lifecycle = (typeof ids)[number];

async function load(id: Lifecycle) {
  const workflow = workflowSchema.parse(parse(await loadWorkflowTemplate(directory, id)));
  expect(workflow.selection.task_types).toEqual([id]);
  expect(workflow.quality_policy).toBe("task-default");
  return workflow;
}

function graphOf(workflow: Workflow) {
  return {
    steps: workflow.steps,
    gates: workflow.gates.map((gate) =>
      gate.before === undefined
        ? { id: gate.id, after: gate.after ?? "" }
        : { id: gate.id, before: gate.before },
    ),
  };
}

// As in specialist dispatch, evidence gate policies become the generic engine's required
// check ids. Approval and develop-merge policies use their existing dedicated boundaries;
// these tests keep the merge gate open rather than manufacturing a merge or a PO decision.
function checksFor(workflow: Workflow, stepId: string) {
  return workflow.gates
    .filter((gate) => gate.after === stepId && gate.policy !== "develop-merge")
    .map((gate) => gate.policy);
}

async function execute(
  r: Rig,
  workflow: Workflow,
  step: Workflow["steps"][number],
  mode: "good" | "missing" | "phantom" | "empty" | "corrupt" | "stale" = "good",
  omittedCheck?: string,
) {
  const rowId = `step-${step.id}`;
  r.steps.rows.set(rowId, {
    id: rowId,
    runId: "run-1",
    stepId: step.id,
    status: "ready",
    version: 1,
  });
  const input = dispatchInput();
  const dispatched = await dispatchStep(
    { ...r.deps, catalog },
    {
      ...input,
      stepRunId: rowId,
      role: step.role,
      stepSkills: step.skills,
      stepRules: step.rules,
      requiredChecks: checksFor(workflow, step.id),
      models: {
        schema_version: 1,
        models: { test: { executor: "claude-code", model: "opus", supported_efforts: ["high"] } },
        capability_profiles: { [step.capability_profile]: { min_effort: "medium" } },
        verified_models: { [step.capability_profile]: ["test"] },
      },
      context: {
        taskSnapshot: { issueNumber: 41, title: workflow.id, body: "Task data" },
        acceptanceCriteria: ["Deliver the approved change with verified evidence"],
        businessBaselineHash: "9".repeat(64),
        capabilityProfile: { id: step.capability_profile, min_effort: "medium" },
        inputArtifacts: [],
        previousFindings: [],
        expectedOutputSchema: step.output_contract,
        allowedScope: { paths: ["src", "tests", "docs"] },
        approvalRefs: [],
      },
    },
  );
  if (!dispatched.ok) throw new Error(dispatched.reason);
  expect(dispatched.contextPacket.role).toBe(step.role);
  expect(dispatched.contextPacket.expectedOutputSchema).toBe(step.output_contract);
  expect(dispatched.attempt.rules.map((rule) => rule.id)).toEqual(
    expect.arrayContaining(["project-baseline", "approval-gates", "evidence-and-tests"]),
  );
  const artifact = r.artifacts.publish(
    `${dispatched.attempt.artifactRoot}/evidence.txt`,
    mode === "empty"
      ? ""
      : `${workflow.id}/${step.id} at ${HEAD}: regression fails before fix, passes after; ` +
          "original test files unchanged, full suite passes; docs criteria reviewed and accepted.",
  );
  if (mode === "corrupt")
    r.artifacts.files.set(artifact.path, new TextEncoder().encode("changed after publication"));
  return recordStepResult(r.deps, {
    attemptId: dispatched.attempt.id,
    execution: await r.executor.collectResult(dispatched.handle),
    result: {
      schemaVersion: 1,
      runId: "run-1",
      stepId: step.id,
      attemptId: dispatched.attempt.id,
      status: "succeeded",
      summary: "Worker claims success",
      artifacts: mode === "phantom" ? [] : [artifact],
      revision: { headSha: mode === "stale" ? "c".repeat(40) : HEAD, baseSha: BASE },
      checks: checksFor(workflow, step.id)
        .filter((id) => mode !== "missing" || id !== omittedCheck)
        .map((id) => ({ id, evidenceRef: artifact.path })),
      findings: [],
    },
  });
}

describe("lifecycle templates use the shared workflow engine", () => {
  it.each(ids)(
    "%s runs every step through real resolution, dispatch and result validation",
    async (id) => {
      const workflow = await load(id);
      const graph = graphOf(workflow);
      expect(validateWorkflowGraph(graph)).toEqual([]);
      const r = rig();
      const statuses = new Map<string, StepStatus>();
      const gates = new Map<string, GateStatus>();
      const scope = workflow.gates.find((gate) => gate.policy === "approved-business-baseline");
      if (scope === undefined || scope.before === undefined) throw new Error("missing scope gate");
      expect(scope.before).toBe(id === "docs" ? "write" : "implement");

      for (const step of workflow.steps) {
        if (step.id === scope.before) {
          expect(evaluateStepStartability(graph, statuses, gates)).toContainEqual(
            expect.objectContaining({
              stepId: step.id,
              startable: false,
              waitingOnGates: [scope.id],
            }),
          );
          // Simulate the trusted approval boundary reporting an already approved baseline.
          gates.set(scope.id, "passed");
        }
        expect(evaluateStepStartability(graph, statuses, gates)).toContainEqual(
          expect.objectContaining({ stepId: step.id, startable: true }),
        );
        expect(await execute(r, workflow, step)).toMatchObject({
          ok: true,
          stepStatus: "succeeded",
        });
        statuses.set(step.id, "succeeded");
        for (const gate of workflow.gates) {
          if (gate.after === step.id && gate.policy !== "develop-merge")
            gates.set(gate.id, "passed");
        }
      }
      expect(r.executor.started).toHaveLength(workflow.steps.length);
      const review = workflow.steps.find((step) => step.role === "reviewer");
      expect(review?.skills).toContain("independent-review");
      expect(review?.needs).toEqual(["verify"]);
      expect(workflow.gates).toContainEqual({
        id: "ready-to-merge",
        after: review?.id,
        policy: "develop-merge",
      });
      // Even all-successful workers cannot declare Done without the real delivery gate.
      expect(evaluateRunCompletion(graph, statuses, gates)).toEqual(["MANDATORY_GATE_NOT_PASSED"]);
    },
  );

  it.each([
    ["bugfix", "verify", "regression-test"],
    ["refactor", "verify", "existing-tests-unchanged"],
    ["refactor", "verify", "existing-tests-passing"],
    ["docs", "accept", "docs-acceptance"],
  ] as const)("%s fails without %s / %s evidence despite exit zero", async (id, stepId, check) => {
    const workflow = await load(id);
    const step = workflow.steps.find((candidate) => candidate.id === stepId);
    if (step === undefined) throw new Error("missing verification/acceptance step");
    expect(checksFor(workflow, step.id)).toContain(check);
    const r = rig();
    expect(await execute(r, workflow, step, "missing", check)).toMatchObject({
      ok: true,
      stepStatus: "failed",
      failure: "REQUIRED_CHECK_MISSING",
    });
    const statuses = new Map<string, StepStatus>(workflow.steps.map((s) => [s.id, "succeeded"]));
    statuses.set(step.id, "failed");
    expect(evaluateRunCompletion(graphOf(workflow), statuses, new Map())).toContain(
      "STEPS_NOT_SUCCEEDED",
    );
    expect(evaluateRunCompletion(graphOf(workflow), statuses, new Map())).toContain(
      "MANDATORY_GATE_NOT_PASSED",
    );
  });

  it.each(["bugfix", "refactor", "docs"] as const)(
    "%s refuses invalid evidence artifacts and stale revisions",
    async (id) => {
      const workflow = await load(id);
      const step = workflow.steps.find((s) => s.id === (id === "docs" ? "accept" : "verify"));
      if (step === undefined) throw new Error("missing evidence step");
      for (const mode of ["phantom", "empty", "corrupt", "stale"] as const) {
        const result = await execute(rig(), workflow, step, mode);
        if (mode === "stale") expect(result).toMatchObject({ ok: false, reason: "STALE_REVISION" });
        else
          expect(result).toMatchObject({
            ok: true,
            stepStatus: "failed",
            failure: mode === "corrupt" ? "ARTIFACT_HASH_MISMATCH" : "ARTIFACT_INVALID",
          });
      }
    },
  );
});
