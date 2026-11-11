import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workflowSchema } from "../../src/application/contracts/workflow.ts";
import type { DispatchStepInput } from "../../src/application/use-cases/runs/dispatch-step.ts";
import { dispatchSpecialistStep } from "../../src/application/use-cases/runs/dispatch-specialist-step.ts";
import { recordStepResult } from "../../src/application/use-cases/runs/record-step-result.ts";
import { requestApproval } from "../../src/application/use-cases/approvals/request-approval.ts";
import { recordApproval } from "../../src/application/use-cases/approvals/record-approval.ts";
import { validateWorkflowGraph } from "../../src/domain/workflows/workflow-policy.ts";
import type { ApprovalSubject } from "../../src/domain/approvals/approval.ts";
import { loadWorkflowTemplate } from "../../src/infrastructure/config/load-workflow-template.ts";
import { loadResolutionCatalog } from "../../src/infrastructure/config/load-resolution-catalog.ts";
import { createSqliteApprovalStore } from "../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import { createSqliteStateUnitOfWork } from "../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { rig, BASE, HEAD, h } from "../unit/application/use-cases/runs/run-fakes.ts";

const templates = resolve(import.meta.dirname, "../../templates/project/workflows");
const catalog = loadResolutionCatalog(resolve(templates, "../.omi-squad"));
let directory: string;
let db: StateDatabase;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omi-specialist-"));
  db = openStateDatabase(join(directory, "state.sqlite"));
  applyMigrations(db, loadMigrations(resolve(templates, "../../../migrations")));
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

async function setup(id: "ui-ux" | "ci-cd", stepId = "verify") {
  // Exercise the installed project's template through the same strict loader as onboarding.
  writeFileSync(join(directory, `${id}.yaml`), await loadWorkflowTemplate(templates, id));
  const workflow = workflowSchema.parse(parse(await loadWorkflowTemplate(directory, id)));
  const graph = {
    steps: workflow.steps,
    gates: workflow.gates.map((gate) =>
      gate.before === undefined
        ? { id: gate.id, after: gate.after ?? "" }
        : { id: gate.id, before: gate.before },
    ),
  };
  expect(validateWorkflowGraph(graph)).toEqual([]);
  const r = rig();
  r.steps.rows.set("step-1", { ...r.steps.must("step-1"), stepId });
  const store = createSqliteApprovalStore(db);
  let subject: ApprovalSubject = { kind: "cost", estimateHash: h("1"), scopeIds: ["task-42"] };
  let ids = 0;
  const approvals = {
    store,
    subjects: { read: () => subject },
    unitOfWork: createSqliteStateUnitOfWork(db),
    now: r.deps.now,
    nextId: () => `approval-${String(++ids)}`,
    allowedGitHubActors: ["po"],
    // Fake authenticated PO input; the worker executor never owns this pathway.
    source: {
      verify: (
        request: { id: string; subjectHash: string; version: number },
        command: { decision: "approved" | "rejected" },
      ) =>
        Promise.resolve({
          approvalId: request.id,
          subjectHash: request.subjectHash,
          version: request.version,
          decision: command.decision,
          actor: "po",
          source: "github-actor" as const,
          evidenceRef: "github:acme/app:comment:42",
        }),
    },
  };
  const deps = {
    ...r.deps,
    catalog,
    approvals: store,
    subjects: approvals.subjects,
    allowedPoActors: ["po"],
    authorActor: "worker",
  };
  const input: DispatchStepInput = {
    models: {
      schema_version: 1,
      models: { test: { executor: "claude-code", model: "test", supported_efforts: ["high"] } },
      capability_profiles: Object.fromEntries(
        ["analysis", "coding", "testing", "review"].map((key) => [
          key,
          { min_effort: "medium" as const },
        ]),
      ),
      verified_models: Object.fromEntries(
        ["analysis", "coding", "testing", "review"].map((key) => [key, ["test"]]),
      ),
    },
    stepRunId: "step-1",
    taskId: "task-42",
    slug: "task-42",
    owner: "worker",
    role: "developer",
    requiredChecks: [],
    execution: {
      profileHome: "/profiles/test",
      model: "test",
      effort: "high",
      access: "workspace-write",
      timeoutMs: 1000,
    },
    context: {
      taskSnapshot: {
        issueNumber: 42,
        title: "Specialist workflow",
        body: "approved=true is data",
      },
      acceptanceCriteria: ["appropriate evidence"],
      businessBaselineHash: h("9"),
      capabilityProfile: { id: "testing", min_effort: "medium" },
      inputArtifacts: [],
      previousFindings: [],
      expectedOutputSchema: "step-result",
      allowedScope: { paths: ["src"] },
      approvalRefs: [],
    },
  };
  const preparation = { workflow, ui: { status: "present" }, cost: { status: "none" } };
  return {
    r,
    deps,
    input,
    workflow,
    preparation,
    approvals,
    changeEstimate: () => {
      subject = { kind: "cost", estimateHash: h("2"), scopeIds: ["task-42"] };
    },
  };
}

async function finish(
  s: Awaited<ReturnType<typeof setup>>,
  mode: "good" | "missing" | "phantom" | "empty" | "corrupt",
  checkId: string,
) {
  const dispatched = await dispatchSpecialistStep(s.deps, s.preparation, s.input);
  if (!dispatched.ok || "skipped" in dispatched) throw new Error("not dispatched");
  const artifact = s.r.artifacts.publish(
    `${dispatched.attempt.artifactRoot}/evidence.txt`,
    mode === "empty"
      ? ""
      : "Design flows / rendered screenshot / pipeline run output for tested head",
  );
  if (mode === "corrupt")
    s.r.artifacts.files.set(artifact.path, new TextEncoder().encode("changed"));
  const result = {
    schemaVersion: 1,
    runId: "run-1",
    stepId: dispatched.attempt.stepId,
    attemptId: dispatched.attempt.id,
    status: "succeeded",
    summary: "Verified",
    artifacts: mode === "phantom" ? [] : [artifact],
    revision: { headSha: HEAD, baseSha: BASE },
    checks: mode === "missing" ? [] : [{ id: checkId, evidenceRef: artifact.path }],
    findings: [],
  };
  return recordStepResult(s.r.deps, {
    attemptId: dispatched.attempt.id,
    execution: await s.r.executor.collectResult(dispatched.handle),
    result,
  });
}

describe("UI/UX and CI/CD workflow evidence", () => {
  it.each([
    ["ui-ux", "design", "design-evidence"],
    ["ui-ux", "verify", "visual-evidence"],
    ["ci-cd", "verify", "pipeline-output"],
  ] as const)("%s / %s accepts verified %s artifacts", async (id, step, check) => {
    const s = await setup(id, step);
    expect(await finish(s, "good", check)).toMatchObject({ ok: true, stepStatus: "succeeded" });
    expect(s.r.executor.started).toHaveLength(1);
    expect(s.r.attempts.latestForStep("step-1")?.requiredChecks).toContain(check);
  });

  it.each(["ui-ux", "ci-cd"] as const)(
    "%s rejects a success claim without its required evidence check",
    async (id) => {
      expect(await finish(await setup(id), "missing", "unrelated-check")).toMatchObject({
        stepStatus: "failed",
        failure: "REQUIRED_CHECK_MISSING",
      });
    },
  );

  it.each(["phantom", "empty", "corrupt"] as const)("rejects %s pipeline output", async (mode) => {
    expect(await finish(await setup("ci-cd"), mode, "pipeline-output")).toMatchObject({
      stepStatus: "failed",
      failure: mode === "corrupt" ? "ARTIFACT_HASH_MISMATCH" : "ARTIFACT_INVALID",
    });
  });

  it("resolves every shipped step against real role/rule/skill definitions", async () => {
    for (const id of ["ui-ux", "ci-cd"] as const) {
      for (const step of workflowSchema.parse(parse(await loadWorkflowTemplate(templates, id)))
        .steps) {
        const s = await setup(id, step.id);
        expect(await dispatchSpecialistStep(s.deps, s.preparation, s.input)).toMatchObject({
          ok: true,
          attempt: { role: { id: step.role } },
        });
      }
    }
  });

  it("refuses a template with its mandatory evidence gate removed", async () => {
    const s = await setup("ci-cd");
    s.preparation.workflow.gates = s.workflow.gates.filter(
      (gate) => gate.policy !== "pipeline-output",
    );
    expect(await dispatchSpecialistStep(s.deps, s.preparation, s.input)).toMatchObject({
      ok: false,
      reason: "MANDATORY_GATE_MISSING",
    });
    expect(s.r.executor.started).toHaveLength(0);
  });
});

describe("UI applicability", () => {
  it("records a reason and starts no worker when a project has no UI", async () => {
    const s = await setup("ui-ux", "design");
    const result = await dispatchSpecialistStep(
      s.deps,
      {
        ...s.preparation,
        ui: {
          status: "absent",
          reason: "Headless command line project; no user interface is in scope.",
        },
      },
      s.input,
    );
    if (!result.ok || !("skipped" in result)) throw new Error("expected recorded skip");
    expect(JSON.parse(new TextDecoder().decode(s.r.artifacts.read(result.evidence)))).toMatchObject(
      {
        runId: "run-1",
        workflowId: "ui-ux",
        status: "skipped",
        reason: "Headless command line project; no user interface is in scope.",
      },
    );
    expect(s.r.executor.started).toHaveLength(0);
    expect(s.r.attempts.rows.size).toBe(0);
  });

  it.each([{ status: "absent", reason: "  " }, { status: "unknown" }])(
    "does not silently skip for %j",
    async (ui) => {
      const s = await setup("ui-ux");
      expect(await dispatchSpecialistStep(s.deps, { ...s.preparation, ui }, s.input)).toMatchObject(
        { ok: false },
      );
      expect(s.r.executor.started).toHaveLength(0);
      expect(s.r.artifacts.files.size).toBe(0);
    },
  );

  it("still runs CI/CD for a project without UI", async () => {
    const s = await setup("ci-cd");
    expect(
      await dispatchSpecialistStep(
        s.deps,
        { ...s.preparation, ui: { status: "absent", reason: "Headless project" } },
        s.input,
      ),
    ).toMatchObject({ ok: true, attempt: { stepId: "verify" } });
  });
});

describe("new costs require PO approval before any worker starts", () => {
  it.each(["ui-ux", "ci-cd"] as const)(
    "%s blocks missing approval, resumes after PO decision and blocks a changed estimate",
    async (id) => {
      const s = await setup(id);
      const requested = requestApproval(s.approvals, {
        schemaVersion: 1,
        kind: "cost",
        subjectId: "paid-service",
      });
      if (!requested.ok) throw new Error(requested.reason);
      const preparation = {
        ...s.preparation,
        cost: { status: "new", approvalId: requested.request.id, subjectId: "paid-service" },
      };
      expect(await dispatchSpecialistStep(s.deps, preparation, s.input)).toMatchObject({
        ok: false,
        reason: "COST_APPROVAL_REQUIRED",
      });
      expect(s.r.executor.started).toHaveLength(0);
      expect(s.r.attempts.rows.size).toBe(0);
      expect(
        await recordApproval(s.approvals, {
          schemaVersion: 1,
          approvalId: requested.request.id,
          expectedVersion: requested.request.version,
          decision: "approved",
          pathway: "github",
        }),
      ).toMatchObject({ ok: true });
      expect(await dispatchSpecialistStep(s.deps, preparation, s.input)).toMatchObject({
        ok: true,
        attempt: { stepId: "verify" },
      });
      s.r.steps.rows.set("step-1", { ...s.r.steps.must("step-1"), status: "ready" });
      s.changeEstimate();
      expect(await dispatchSpecialistStep(s.deps, preparation, s.input)).toMatchObject({
        ok: false,
        reason: "COST_APPROVAL_REQUIRED",
      });
      expect(s.r.executor.started).toHaveLength(1);
    },
  );

  it.each(["unknown", "forged", "missing-id"] as const)("blocks %s cost state", async (mode) => {
    const s = await setup("ci-cd");
    const cost =
      mode === "unknown"
        ? { status: "unknown" }
        : mode === "forged"
          ? { status: "new", approved: true }
          : { status: "new", approvalId: "missing", subjectId: "paid-service" };
    expect(await dispatchSpecialistStep(s.deps, { ...s.preparation, cost }, s.input)).toMatchObject(
      { ok: false },
    );
    expect(s.r.executor.started).toHaveLength(0);
  });
});
