import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workflowSchema } from "../../src/application/contracts/workflow.ts";
import { resolveRoleContext } from "../../src/application/services/resolve-role-context.ts";
import { checkExecutionApprovals } from "../../src/application/services/check-execution-approvals.ts";
import { requestApproval } from "../../src/application/use-cases/approvals/request-approval.ts";
import {
  recordApproval,
  type RecordApprovalDependencies,
} from "../../src/application/use-cases/approvals/record-approval.ts";
import type { ApprovalRequest, ApprovalSubject } from "../../src/domain/approvals/approval.ts";
import { validateTaskDependencies } from "../../src/domain/tasks/dependency-policy.ts";
import { validateWorkflowGraph } from "../../src/domain/workflows/workflow-policy.ts";
import { loadResolutionCatalog } from "../../src/infrastructure/config/load-resolution-catalog.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { createSqliteApprovalStore } from "../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteStateUnitOfWork } from "../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";

const root = resolve(import.meta.dirname, "..", "..");
const templates = join(root, "templates", "project");
const workflow = workflowSchema.parse(
  parse(readFileSync(join(templates, "workflows", "idea-to-issues.yaml"), "utf8")),
);
const catalog = loadResolutionCatalog(join(templates, ".omi-squad"));

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const PO = "po";

let dir: string;
let db: StateDatabase;
let now: number;
let ids: number;
/** The authoritative requirements baseline the PO is asked to approve. */
let baseline: ApprovalSubject;
let deps: RecordApprovalDependencies;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-idea-"));
  db = openStateDatabase(join(dir, "state.db"));
  applyMigrations(db, loadMigrations(join(root, "migrations")));
  now = 1000;
  ids = 0;
  baseline = { kind: "business", baselineHash: H1, scopeIds: ["export", "import"] };
  deps = {
    store: createSqliteApprovalStore(db),
    unitOfWork: createSqliteStateUnitOfWork(db),
    subjects: { read: () => baseline },
    now: () => now,
    nextId: () => `id-${String(++ids)}`,
    allowedGitHubActors: [PO],
    // The trusted adapter attests the PO decision; nothing the agent writes reaches it.
    source: {
      verify: (request: ApprovalRequest, input) =>
        Promise.resolve({
          approvalId: request.id,
          subjectHash: request.subjectHash,
          version: request.version,
          decision: input.decision,
          actor: PO,
          source: "po-cli" as const,
          evidenceRef: "terminal-confirmation",
        }),
    },
  };
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function gateOf(id: string) {
  const gate = workflow.gates.find((candidate) => candidate.id === id);
  if (gate === undefined) throw new Error(`missing gate ${id}`);
  return gate;
}

function request(): ApprovalRequest {
  const result = requestApproval(deps, {
    schemaVersion: 1,
    subjectId: "baseline",
    kind: "business",
  });
  if (!result.ok) throw new Error(result.reason);
  return result.request;
}

/** What the runtime asks right before the step the gate guards runs. */
function gateAllows(approvalId: string) {
  return checkExecutionApprovals(
    { store: deps.store, subjects: deps.subjects, now: deps.now },
    [{ approvalId, subjectId: "baseline", kind: "business" }],
    [PO],
  );
}

async function approve(pending: ApprovalRequest) {
  return recordApproval(deps, {
    schemaVersion: 1,
    approvalId: pending.id,
    expectedVersion: pending.version,
    decision: "approved",
    pathway: "cli",
  });
}

describe("idea → requirements → Issues workflow", () => {
  it("ships a valid, acyclic template whose roles, skills and rules all resolve", () => {
    const gates = workflow.gates.map((gate) =>
      gate.before === undefined
        ? { id: gate.id, after: gate.after ?? "" }
        : { id: gate.id, before: gate.before },
    );
    expect(validateWorkflowGraph({ steps: workflow.steps, gates })).toEqual([]);
    expect(workflow.selection.task_types).toEqual(["idea"]);
    for (const step of workflow.steps) {
      const resolved = resolveRoleContext(catalog, {
        role: step.role,
        stepSkills: step.skills,
        stepRules: step.rules,
      });
      expect(resolved.rules.map((rule) => rule.id)).toEqual(expect.arrayContaining(step.rules));
    }
  });

  it("AC1: nothing is decomposed until the PO approves scope, criteria and baseline", async () => {
    const gate = gateOf("requirements-approved");
    expect(gate).toMatchObject({ before: "decompose", policy: "approved-business-baseline" });
    // The requirements are produced before the gate, decomposition only after it.
    const decompose = workflow.steps.find((step) => step.id === "decompose");
    expect(decompose?.needs).toEqual(["define-requirements"]);

    const pending = request();
    expect(gateAllows(pending.id).allowed).toBe(false);

    const recorded = await approve(pending);
    expect(recorded).toMatchObject({ ok: true });
    expect(gateAllows(pending.id).allowed).toBe(true);
  });

  it("AC1: a baseline changed after approval makes the approval stale", async () => {
    const pending = request();
    await approve(pending);
    baseline = { kind: "business", baselineHash: H2, scopeIds: ["export", "import"] };
    expect(gateAllows(pending.id).allowed).toBe(false);
  });

  it("AC2: the decomposition's Issues are linked by dependencies that form a DAG", () => {
    const decomposition = [
      { id: "export", status: "pending" as const, blockedBy: [] },
      { id: "import", status: "pending" as const, blockedBy: ["export"] },
      { id: "docs", status: "pending" as const, blockedBy: ["export", "import"] },
    ];
    expect(validateTaskDependencies(decomposition)).toEqual([]);
    expect(
      validateTaskDependencies([
        { id: "export", status: "pending", blockedBy: ["docs"] },
        ...decomposition.slice(1),
      ]).map((issue) => issue.code),
    ).toContain("DEPENDENCY_CYCLE");
  });

  it("AC3: the decompose step is told to group by deliverable, never one Issue per step", () => {
    const rule = catalog.rules.find((candidate) => candidate.id === "issue-decomposition");
    expect(rule).toMatchObject({ version: "1", mandatory: false });
    const text = readFileSync(
      join(templates, ".omi-squad", "rules", "issue-decomposition.md"),
      "utf8",
    );
    expect(text).toMatch(/Never create an Issue for a workflow step/);
    expect(text).toMatch(/blocked by/);
    for (const id of ["decompose", "review"]) {
      const step = workflow.steps.find((candidate) => candidate.id === id);
      expect(step?.rules).toContain("issue-decomposition");
    }
    // The rule is opt-in per step: it is not pushed onto every role.
    expect(resolveRoleContext(catalog, { role: "developer" }).rules.map((r) => r.id)).not.toContain(
      "issue-decomposition",
    );
  });

  it("AC4: scope beyond the approved baseline waits for a new PO decision", async () => {
    const pending = request();
    await approve(pending);
    expect(gateAllows(pending.id).allowed).toBe(true);

    // The decomposition proposes extra scope: the baseline the gate reads now differs.
    baseline = { kind: "business", baselineHash: H1, scopeIds: ["export", "import", "sync"] };
    expect(gateAllows(pending.id).allowed).toBe(false);
    expect(workflow.gates.every((gate) => gate.policy === "approved-business-baseline")).toBe(true);

    // Only a fresh decision by the PO on the widened baseline lets it proceed.
    const widened = request();
    expect(gateAllows(widened.id).allowed).toBe(false);
    expect(await approve(widened)).toMatchObject({ ok: true });
    expect(gateAllows(widened.id).allowed).toBe(true);
  });

  it("creates Issues only after the review gate, which also needs the PO", () => {
    expect(gateOf("issues-approved")).toMatchObject({
      after: "review",
      policy: "approved-business-baseline",
    });
  });
});
