import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { createFileSkillSource } from "../../src/infrastructure/config/file-skill-source.ts";
import {
  createFileRuleSource,
  loadResolutionCatalog,
} from "../../src/infrastructure/config/load-resolution-catalog.ts";
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
import { rig, BASE, HEAD, h, skillEvidence } from "../unit/application/use-cases/runs/run-fakes.ts";

const templates = resolve(import.meta.dirname, "../../templates/project/workflows");
const squadDir = resolve(templates, "../.omi");
const catalog = loadResolutionCatalog(squadDir);
const skills = createFileSkillSource(squadDir);
const rules = createFileRuleSource(squadDir);
let directory: string;
let db: StateDatabase;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omi-specialist-"));
  db = openStateDatabase(join(directory, "state.sqlite"));
  applyMigrations(db, loadMigrations(resolve(templates, "../../../migrations")));
  db.exec(`
    INSERT INTO projects (id, repo_identity, config_hash, created_at, updated_at) VALUES ('p','acme/app','h','now','now');
    INSERT INTO task_snapshots (id, project_id, issue_node_id, issue_number, content_hash, remote_updated_at, scope, captured_at) VALUES ('task-42','p','i',42,'h','now','{}','now');
    INSERT INTO workflow_runs (id, task_id, template_hash, status, quality_phase, created_at, updated_at) VALUES ('run-1','task-42','h','running','initial','now','now');
  `);
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
  let subject: ApprovalSubject = {
    kind: "cost",
    estimateHash: h("1"),
    scopeIds: workflow.steps.map((step) => `${step.id}.round-1`),
  };
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
    skills,
    rules,
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
    extendPlan: () => {
      if (subject.kind !== "cost") throw new Error("not cost");
      subject = { ...subject, scopeIds: [...subject.scopeIds, `${stepId}.round-2`] };
    },
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
  const skillProof = skillEvidence(dispatched.attempt, (path, text) =>
    s.r.artifacts.publish(path, text),
  );
  const result = {
    schemaVersion: 1,
    runId: "run-1",
    stepId: dispatched.attempt.stepId,
    attemptId: dispatched.attempt.id,
    status: "succeeded",
    summary: "Verified",
    artifacts: mode === "phantom" ? [] : [artifact, ...skillProof.artifacts],
    revision: { headSha: HEAD, baseSha: BASE },
    checks: mode === "missing" ? [] : [{ id: checkId, evidenceRef: artifact.path }],
    skillsApplied: skillProof.skillsApplied,
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
        runId: "run-1",
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

describe("specialist rework skills", () => {
  it.each([
    ["ui-ux", "implement"],
    ["ci-cd", "configure-pipeline"],
  ] as const)(
    "%s %s at round 2 carries receiving-code-review, at round 1 not",
    async (id, step) => {
      const ids = async (round: number) => {
        const s = await setup(id, step);
        const result = await dispatchSpecialistStep(s.deps, s.preparation, {
          ...s.input,
          quality: { policy: "task-default", step, steps: [step], round },
        });
        if (!result.ok || "skipped" in result) throw new Error("not dispatched");
        return result.attempt.skills.map((skill) => skill.id);
      };
      expect(await ids(1)).not.toContain("receiving-code-review");
      expect(await ids(2)).toContain("receiving-code-review");
    },
  );
});

describe("run cost approval scope", () => {
  it.each(["ui-ux", "ci-cd"] as const)(
    "%s reuses one decision for planned steps and requires a new one for extra rework",
    async (id) => {
      const s = await setup(id);
      const request = requestApproval(s.approvals, {
        schemaVersion: 1,
        kind: "cost",
        subjectId: "paid-service",
        runId: "run-1",
      });
      if (!request.ok) throw new Error(request.reason);
      const approve = async (approvalId: string, version: number) => {
        expect(
          await recordApproval(s.approvals, {
            schemaVersion: 1,
            approvalId,
            expectedVersion: version,
            decision: "approved",
            pathway: "github",
          }),
        ).toMatchObject({ ok: true });
      };
      await approve(request.request.id, request.request.version);
      const cost = { status: "new", approvalId: request.request.id, subjectId: "paid-service" };
      for (const step of s.workflow.steps) {
        const next = await setup(id, step.id);
        expect(
          await dispatchSpecialistStep(
            { ...next.deps, approvals: s.deps.approvals, subjects: s.deps.subjects },
            { ...next.preparation, cost },
            next.input,
          ),
        ).toMatchObject({ ok: true });
      }
      const input = {
        ...s.input,
        quality: { policy: "strict", step: "verify", steps: ["verify"], round: 2 },
      };
      expect(await dispatchSpecialistStep(s.deps, { ...s.preparation, cost }, input)).toMatchObject(
        { ok: false, reason: "COST_APPROVAL_REQUIRED" },
      );
      s.extendPlan();
      expect(await dispatchSpecialistStep(s.deps, { ...s.preparation, cost }, input)).toMatchObject(
        { ok: false, reason: "COST_APPROVAL_REQUIRED" },
      );
      const renewed = requestApproval(s.approvals, {
        schemaVersion: 1,
        kind: "cost",
        subjectId: "paid-service",
        runId: "run-1",
      });
      if (!renewed.ok) throw new Error(renewed.reason);
      await approve(renewed.request.id, renewed.request.version);
      expect(
        await dispatchSpecialistStep(
          s.deps,
          { ...s.preparation, cost: { ...cost, approvalId: renewed.request.id } },
          input,
        ),
      ).toMatchObject({ ok: true });
    },
  );

  it.each(["configure-pipeline", "verify"])(
    "refuses a misplaced run cost gate when dispatching %s",
    async (step) => {
      const s = await setup("ci-cd", step);
      s.preparation.workflow.gates = s.workflow.gates
        .filter((gate) => gate.policy !== "approved-cost")
        .concat([{ id: "run-cost-approved", before: "verify", policy: "approved-cost" }]);
      expect(await dispatchSpecialistStep(s.deps, s.preparation, s.input)).toMatchObject({
        ok: false,
        reason: "MANDATORY_GATE_MISSING",
      });
      expect(s.r.executor.started).toHaveLength(0);
    },
  );
});

it.each(["missing-run", "partial-plan", "recorded-rework"] as const)(
  "refuses %s cost approval scope",
  async (mode) => {
    const s = await setup("ci-cd");
    if (mode === "partial-plan")
      s.approvals.subjects.read = () => ({
        kind: "cost",
        estimateHash: h("1"),
        scopeIds: ["verify.round-1"],
      });
    const request = requestApproval(s.approvals, {
      schemaVersion: 1,
      kind: "cost",
      subjectId: "paid-service",
      ...(mode === "missing-run" ? {} : { runId: "run-1" }),
    });
    if (!request.ok) throw new Error(request.reason);
    expect(
      await recordApproval(s.approvals, {
        schemaVersion: 1,
        approvalId: request.request.id,
        expectedVersion: request.request.version,
        decision: "approved",
        pathway: "github",
      }),
    ).toMatchObject({ ok: true });
    const attempts =
      mode === "recorded-rework"
        ? Object.assign(s.deps.attempts, { qualityHistory: () => ({ round: 2 }) })
        : s.deps.attempts;
    expect(
      await dispatchSpecialistStep(
        { ...s.deps, attempts },
        {
          ...s.preparation,
          cost: { status: "new", approvalId: request.request.id, subjectId: "paid-service" },
        },
        s.input,
      ),
    ).toMatchObject({ ok: false, reason: "COST_APPROVAL_REQUIRED" });
    expect(s.r.executor.started).toHaveLength(0);
  },
);

it.each(["ui-ux", "ci-cd"] as const)(
  "still dispatches the archived %s per-step cost gates",
  async (id) => {
    const workflow = workflowSchema.parse(
      parse(readFileSync(`tests/fixtures/workflow-archive/${id}-small-steps.yaml`, "utf8")),
    );
    for (const step of workflow.steps) {
      const s = await setup(id, step.id);
      expect(
        await dispatchSpecialistStep(s.deps, { ...s.preparation, workflow }, s.input),
      ).toMatchObject({ ok: true });
    }
  },
);
