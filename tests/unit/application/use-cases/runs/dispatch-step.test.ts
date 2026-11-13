import { describe, expect, it } from "vitest";
import {
  executionRequestSchema,
  MAX_PROMPT_CHARS,
} from "../../../../../src/application/contracts/agent-execution.ts";
import { contextPacketSchema } from "../../../../../src/application/contracts/context.ts";
import { GitWorkspaceError } from "../../../../../src/application/ports/git-workspace.ts";
import {
  dispatchStep,
  type DispatchStepResult,
} from "../../../../../src/application/use-cases/runs/dispatch-step.ts";
import { dispatchInput, h, rig, role, HEAD, BASE, skillEvidence } from "./run-fakes.ts";
import { recordStepResult } from "../../../../../src/application/use-cases/runs/record-step-result.ts";

function dispatched(result: DispatchStepResult) {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

describe("dispatchStep", () => {
  it("generates numbered Issue criteria, worker rules and the result format before dispatch", async () => {
    const r = rig();
    dispatched(await dispatchStep(r.deps, dispatchInput()));
    const prompt = r.executor.started[0]?.prompt ?? "";
    expect(prompt).toContain("Acceptance criteria (1 top-level criteria)");
    expect(prompt).toContain("AC-1:");
    expect(prompt).toContain("Do not push, open PRs, merge, or change GitHub state.");
    expect(prompt).toContain("Do not write under .claude/.");
    expect(prompt).toContain('"skillsApplied"');
    expect(prompt).toContain('"checks"');
    expect(prompt).toContain("one AC-n: met|not met — <evidence> line per criterion");
  });
  it("completes an attempt id reserved by executor selection instead of allocating another", async () => {
    const r = rig();
    const result = dispatched(
      await dispatchStep(r.deps, dispatchInput({ reservedAttemptId: "reserved-1" })),
    );
    expect(result.attempt.id).toBe("reserved-1");
    expect(r.attempts.get("reserved-1")?.status).toBe("running");
    expect(r.executor.started[0]?.attemptId).toBe("reserved-1");
  });

  it("allocates attempt, context packet and worktree, then hands them to the executor", async () => {
    const r = rig();
    const result = dispatched(await dispatchStep(r.deps, dispatchInput()));

    expect(result.attempt).toMatchObject({
      id: "id-1",
      attemptNumber: 1,
      status: "running",
      workspace: { path: "/work/omi-017", owner: "worker-1", generation: 1 },
    });
    expect(r.attempts.get("id-1")?.status).toBe("running");
    expect(r.steps.rows.get("step-1")).toMatchObject({ status: "running", version: 2 });
    expect(r.unitOfWork.commits[0]?.fence).toEqual({
      resourceKey: "worktree:omi-017",
      owner: "worker-1",
      generation: 1,
    });
    // The packet is stored as a runtime artifact and the attempt pins its hash.
    const stored = r.artifacts.read(result.attempt.contextPacket);
    expect(contextPacketSchema.parse(JSON.parse(new TextDecoder().decode(stored)))).toEqual(
      result.contextPacket,
    );
    expect(r.executor.started).toHaveLength(1);
    expect(r.executor.started[0]).toMatchObject({
      attemptId: "id-1",
      workspace: "/work/omi-017",
      model: "opus",
      effort: "high",
      access: "workspace-write",
    });
  });

  it("puts exactly the resolver's skills and rules, with version and hash, in packet, attempt and executor prompt", async () => {
    const r = rig();
    const result = dispatched(await dispatchStep(r.deps, dispatchInput()));

    const skills = [{ id: "tdd", version: "1", sha256: h("a") }];
    const rules = [
      { id: "architecture-boundaries", version: "1", sha256: h("d") },
      { id: "project-baseline", version: "4", sha256: h("e") },
    ];
    expect(result.contextPacket.skillsManifest).toEqual(skills);
    expect(result.contextPacket.rulesManifest).toEqual(rules);
    expect(result.attempt.skills).toEqual(skills);
    expect(result.attempt.rules).toEqual(rules);
    expect(r.attempts.get(result.attempt.id)).toMatchObject({ skills, rules });
    expect(result.attempt.role).toEqual({ id: "developer", version: 3, sha256: h("1") });

    const prompt = r.executor.started[0]?.prompt ?? "";
    expect(prompt).toContain(h("a"));
    expect(prompt).toContain(h("e"));
    // The library skill the role does not use is not handed over.
    expect(prompt).not.toContain("debugging");
    expect(prompt).not.toContain(h("c"));
  });

  it("inlines role and mandatory rules verbatim after skills in manifest order", async () => {
    const r = rig();
    const files = new Map([
      [
        "architecture-boundaries",
        {
          sha256: h("d"),
          ruleMd: "---\nid: architecture-boundaries\n---\nKeep layers pure.  \n\n",
        },
      ],
      ["project-baseline", { sha256: h("e"), ruleMd: "MANDATORY BASELINE\n" }],
    ]);
    dispatched(
      await dispatchStep(
        { ...r.deps, rules: { read: (id: string) => files.get(id) } },
        dispatchInput(),
      ),
    );
    const prompt = r.executor.started[0]?.prompt ?? "";
    expect(prompt).toContain(
      "=== Rule architecture-boundaries (version 1) ===\n" +
        (files.get("architecture-boundaries")?.ruleMd ?? ""),
    );
    expect(prompt).toContain("=== Rule project-baseline (version 4) ===\nMANDATORY BASELINE\n");
    expect(prompt.indexOf("=== Rule architecture-boundaries")).toBeGreaterThan(
      prompt.indexOf("=== End of skill tdd ==="),
    );
    expect(prompt.indexOf("=== Rule project-baseline")).toBeGreaterThan(
      prompt.indexOf("=== Rule architecture-boundaries"),
    );
    expect(prompt).not.toContain("Script first, LLM second: do deterministic steps");
  });

  it.each([
    [undefined, "RULE_MISSING"],
    [{ sha256: h("0"), ruleMd: "TAMPERED" }, "RULE_HASH_MISMATCH"],
  ])(
    "refuses unreadable or changed rules before allocating anything (%s)",
    async (content, reason) => {
      const r = rig();
      const result = await dispatchStep(
        { ...r.deps, rules: { read: () => content } },
        dispatchInput(),
      );
      expect(result).toEqual({ ok: false, reason, detail: "architecture-boundaries" });
      expect(r.attempts.rows.size).toBe(0);
      expect(r.executor.started).toHaveLength(0);
      expect(r.workspaces.leases.size).toBe(0);
      expect(r.artifacts.files.size).toBe(0);
      expect(r.unitOfWork.commits).toHaveLength(0);
    },
  );

  it("inlines mandatory rules when role rules are empty and omits excluded optional rules", async () => {
    const r = rig();
    const catalog = r.deps.catalog;
    const roles = catalog.roles.map((role) => ({
      ...role,
      definition: { ...role.definition, rules: [] },
    }));
    dispatched(
      await dispatchStep(
        { ...r.deps, catalog: { ...catalog, roles } },
        dispatchInput({
          stepRules: ["architecture-boundaries"],
          excludedRules: ["architecture-boundaries"],
        }),
      ),
    );
    const prompt = r.executor.started[0]?.prompt ?? "";
    expect(prompt).toContain("=== Rule project-baseline (version 4) ===");
    expect(prompt).not.toContain("architecture-boundaries");
  });

  it("inlines optional rules added by the step", async () => {
    const r = rig();
    const catalog = r.deps.catalog;
    const roles = catalog.roles.map((role) => ({
      ...role,
      definition: { ...role.definition, rules: [] },
    }));
    dispatched(
      await dispatchStep(
        { ...r.deps, catalog: { ...catalog, roles } },
        dispatchInput({ stepRules: ["architecture-boundaries"] }),
      ),
    );
    expect(r.executor.started[0]?.prompt).toContain(
      "=== Rule architecture-boundaries (version 1) ===",
    );
  });

  it("applies the existing skill prompt size limit to verbatim rule text", async () => {
    const r = rig();
    let ruleMd = "x";
    const rules = {
      read: (id: string) => {
        const entry = r.deps.catalog.rules.find((rule) => rule.id === id);
        return entry === undefined ? undefined : { sha256: entry.sha256, ruleMd };
      },
    };
    dispatched(await dispatchStep({ ...r.deps, rules }, dispatchInput()));
    const request = r.executor.started[0];
    expect(executionRequestSchema.safeParse(request).success).toBe(true);
    r.steps.rows.set("step-1", { ...r.steps.must("step-1"), status: "ready" });
    ruleMd = "x".repeat(MAX_PROMPT_CHARS);
    dispatched(await dispatchStep({ ...r.deps, rules }, dispatchInput()));
    const oversized = r.executor.started[1];
    expect(oversized?.prompt).toContain(ruleMd);
    const parsed = executionRequestSchema.safeParse(oversized);
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ code: "too_big", path: ["prompt"], maximum: MAX_PROMPT_CHARS }),
      );
  });

  it("inlines the SKILL.md of exactly the manifest skills in manifest order and names bundled files by path", async () => {
    const r = rig();
    const result = dispatched(
      await dispatchStep(r.deps, dispatchInput({ stepSkills: ["debugging"] })),
    );
    const prompt = r.executor.started[0]?.prompt ?? "";
    expect(result.attempt.skills.map((s) => s.id)).toEqual(["debugging", "tdd"]);
    const debugging = prompt.indexOf("Reproduce first.");
    const tdd = prompt.indexOf("Write the failing test first.");
    expect(debugging).toBeGreaterThan(-1);
    expect(tdd).toBeGreaterThan(debugging);
    expect(prompt).toContain(".omi-squad/skills/tdd/references/cycle.md");
  });

  it("inlines no skill text the manifest does not contain", async () => {
    const r = rig();
    r.skills.files.set("unrelated", {
      sha256: h("f"),
      skillMd: "UNRELATED BODY",
      bundledFiles: [],
    });
    dispatched(await dispatchStep(r.deps, dispatchInput()));
    const prompt = r.executor.started[0]?.prompt ?? "";
    expect(prompt).toContain("Write the failing test first.");
    expect(prompt).not.toContain("Reproduce first.");
    expect(prompt).not.toContain("UNRELATED BODY");
  });

  it("refuses with SKILL_MISSING when a manifest skill has no content, before allocating anything", async () => {
    const r = rig();
    r.skills.files.delete("tdd");
    const result = await dispatchStep(r.deps, dispatchInput());
    expect(result).toMatchObject({ ok: false, reason: "SKILL_MISSING" });
    expect(result.ok ? "" : result.detail).toContain("tdd");
    expect(r.attempts.rows.size).toBe(0);
    expect(r.executor.started).toHaveLength(0);
    expect(r.workspaces.leases.size).toBe(0);
    expect(r.artifacts.files.size).toBe(0);
    expect(r.steps.rows.get("step-1")?.status).toBe("ready");
  });

  it("refuses with SKILL_HASH_MISMATCH when the content hash differs from the manifest", async () => {
    const r = rig();
    r.skills.files.set("tdd", { sha256: h("0"), skillMd: "TAMPERED", bundledFiles: [] });
    const result = await dispatchStep(r.deps, dispatchInput());
    expect(result).toMatchObject({ ok: false, reason: "SKILL_HASH_MISMATCH" });
    expect(result.ok ? "" : result.detail).toContain("tdd");
    expect(r.attempts.rows.size).toBe(0);
    expect(r.executor.started).toHaveLength(0);
    expect(r.workspaces.leases.size).toBe(0);
  });

  it("adds skills the workflow step asks for", async () => {
    const r = rig();
    const result = dispatched(
      await dispatchStep(r.deps, dispatchInput({ stepSkills: ["debugging"] })),
    );
    expect(result.attempt.skills.map((s) => s.id)).toEqual(["debugging", "tdd"]);
  });

  async function refusedWithoutAllocation(input: Record<string, unknown>) {
    const r = rig();
    const result = await dispatchStep(r.deps, input);
    expect(r.attempts.rows.size).toBe(0);
    expect(r.executor.started).toHaveLength(0);
    expect(r.workspaces.leases.size).toBe(0);
    expect(r.unitOfWork.commits).toHaveLength(0);
    expect(r.artifacts.files.size).toBe(0);
    expect(r.steps.rows.get("step-1")?.status).toBe("ready");
    return result;
  }

  it("refuses an unknown skill reference with the reason", async () => {
    const result = await refusedWithoutAllocation(dispatchInput({ stepSkills: ["no-such-skill"] }));
    expect(result).toMatchObject({ ok: false, reason: "UNKNOWN_REFERENCE" });
    expect(result.ok ? "" : result.detail).toContain("no-such-skill");
  });

  it("refuses an unknown rule and an unknown role", async () => {
    expect(await refusedWithoutAllocation(dispatchInput({ stepRules: ["nope"] }))).toMatchObject({
      reason: "UNKNOWN_REFERENCE",
    });
    expect(await refusedWithoutAllocation(dispatchInput({ role: "ghost" }))).toMatchObject({
      reason: "UNKNOWN_REFERENCE",
    });
  });

  it("refuses when a mandatory gate would be dropped", async () => {
    const result = await refusedWithoutAllocation(
      dispatchInput({ excludedRules: ["project-baseline"] }),
    );
    expect(result).toMatchObject({ ok: false, reason: "MANDATORY_GATE_MISSING" });
    expect(result.ok ? "" : result.detail).toContain("project-baseline");
  });

  it("refuses a step that is not ready, an unknown step and bad input", async () => {
    const running = rig("running");
    expect(await dispatchStep(running.deps, dispatchInput())).toEqual({
      ok: false,
      reason: "STEP_NOT_READY",
    });
    const r = rig();
    expect(await dispatchStep(r.deps, dispatchInput({ stepRunId: "ghost" }))).toEqual({
      ok: false,
      reason: "STEP_NOT_FOUND",
    });
    expect(await dispatchStep(r.deps, { stepRunId: "step-1" })).toEqual({
      ok: false,
      reason: "INVALID_INPUT",
    });
  });

  it("refuses an effort below the step's capability profile", async () => {
    const input = dispatchInput();
    const result = await refusedWithoutAllocation({
      ...input,
      execution: { ...(input.execution as object), effort: "low" },
    });
    expect(result).toEqual({ ok: false, reason: "NO_ELIGIBLE_EXECUTOR" });
  });

  it("refuses an input artifact that is missing or has the wrong hash", async () => {
    const r = rig();
    const input = dispatchInput();
    const context = input.context as Record<string, unknown>;
    const withInput = (sha256: string) => ({
      ...input,
      context: { ...context, inputArtifacts: [{ path: "specs/a.md", sha256 }] },
    });
    expect(await dispatchStep(r.deps, withInput(h("0")))).toMatchObject({
      reason: "INPUT_ARTIFACT_INVALID",
      detail: "NOT_FOUND",
    });
    const ref = r.artifacts.publish("specs/a.md", "spec");
    expect(await dispatchStep(r.deps, withInput(h("0")))).toMatchObject({
      reason: "INPUT_ARTIFACT_INVALID",
      detail: "HASH_MISMATCH",
    });
    expect(await dispatchStep(r.deps, withInput(ref.sha256))).toMatchObject({ ok: true });
  });

  it("refuses when the worktree cannot be allocated", async () => {
    const r = rig();
    r.workspaces.failCreate = new GitWorkspaceError("DIRTY_WORKTREE");
    expect(await dispatchStep(r.deps, dispatchInput())).toEqual({
      ok: false,
      reason: "WORKSPACE_UNAVAILABLE",
      detail: "DIRTY_WORKTREE",
    });
    expect(r.attempts.rows.size).toBe(0);
  });

  it("cancels the attempt and releases the writer when the state change is refused", async () => {
    const r = rig();
    const stale = { get: () => ({ ...r.steps.must("step-1"), version: 0 }) };
    const result = await dispatchStep({ ...r.deps, steps: stale }, dispatchInput());
    expect(result).toEqual({ ok: false, reason: "STATE_REJECTED", detail: "STALE_VERSION" });
    expect(r.attempts.get("id-1")?.status).toBe("cancelled");
    expect(r.workspaces.released).toEqual([1]);
    expect(r.executor.started).toHaveLength(0);
  });

  it("fails the attempt and step and releases the writer when the executor cannot start", async () => {
    const r = rig();
    r.executor.failStart = true;
    const result = await dispatchStep(r.deps, dispatchInput());
    expect(result).toEqual({ ok: false, reason: "EXECUTOR_START_FAILED", detail: "SPAWN_FAILED" });
    expect(r.attempts.get("id-1")?.status).toBe("failed");
    expect(r.steps.rows.get("step-1")?.status).toBe("failed");
    expect(r.workspaces.released).toEqual([1]);
  });

  it("numbers a retry as a new attempt", async () => {
    const r = rig();
    dispatched(await dispatchStep(r.deps, dispatchInput()));
    r.steps.rows.set("step-1", { ...r.steps.must("step-1"), status: "ready" });
    const second = dispatched(await dispatchStep(r.deps, dispatchInput()));
    expect(second.attempt.attemptNumber).toBe(2);
    expect(second.attempt.id).not.toBe("id-1");
  });
  it("refuses a task floor above the explicit effort before allocating resources", async () => {
    expect(
      await refusedWithoutAllocation(
        dispatchInput({
          task: { complexity: "high" },
          effortPolicy: { low: "low", medium: "medium", high: "max" },
        }),
      ),
    ).toEqual({ ok: false, reason: "NO_ELIGIBLE_EXECUTOR" });
  });

  it("refuses undeclared models and unsupported efforts even above the task floor", async () => {
    const input = dispatchInput();
    for (const settings of [{ model: "unknown" }, { effort: "max" }]) {
      expect(
        await refusedWithoutAllocation({
          ...input,
          execution: { ...(input.execution as object), ...settings },
        }),
      ).toEqual({ ok: false, reason: "NO_ELIGIBLE_EXECUTOR" });
    }
  });

  it("records the explicit model, effort and policy reason in the attempt and event", async () => {
    const r = rig();
    const result = dispatched(
      await dispatchStep(r.deps, dispatchInput({ task: { complexity: "high" } })),
    );
    expect(result.attempt.selection).toEqual({
      model: "opus",
      effort: "high",
      reason:
        "field complexity:high; complexity high requires high; capability floor medium; minimum high",
    });
    expect(r.attempts.get(result.attempt.id)?.selection).toEqual(result.attempt.selection);
    const payload: unknown = JSON.parse(r.unitOfWork.commits[0]?.event.payload ?? "{}");
    expect(payload).toMatchObject({ selection: result.attempt.selection });
  });
});

it("hands QA script-run logs before starting the worker", async () => {
  const r = rig();
  let ran = 0;
  const evidence = r.artifacts.publish("attempts/id-1/check.log", "script check: passed");
  const result = await dispatchStep(
    {
      ...r.deps,
      checks: {
        has: () => true,
        run: () => {
          expect(r.executor.started).toHaveLength(0);
          ran += 1;
          return Promise.resolve({
            checkId: "project-check",
            status: "passed" as const,
            exitCode: 0,
            command: ["npm", "run", "check"],
            startedAt: "2026-11-11T00:00:00.000Z",
            endedAt: "2026-11-11T00:00:01.000Z",
            revision: "a".repeat(40),
            evidence,
          });
        },
      },
    },
    dispatchInput({
      quality: { policy: "task-default", step: "review", steps: ["verify", "review"], round: 1 },
      requiredChecks: ["project-check"],
    }),
  );
  expect(result.ok).toBe(true);
  expect(ran).toBe(1);
  const prompt = r.executor.started[0]?.prompt ?? "";
  expect(prompt).toContain("script check: passed");
  expect(prompt).toContain("QA judges the supplied script-run check evidence; do not rerun tests.");
  expect(prompt).toContain("verify + review");
});

it("supplies the previous verdict and Git delta to a repeated quality worker", async () => {
  const r = rig();
  const previousVerdict = {
    schemaVersion: 1 as const,
    runId: "run-1",
    stepId: "review",
    attemptId: "old-1",
    status: "failed" as const,
    summary: "previous FAIL: missing error case",
    artifacts: [],
    revision: { headSha: "b".repeat(40), baseSha: "c".repeat(40) },
    checks: [],
    skillsApplied: [],
    findings: [],
  };
  const result = await dispatchStep(
    {
      ...r.deps,
      attempts: Object.assign(r.attempts, {
        qualityHistory: () => ({ round: 2, previousVerdict }),
      }),
      workspaces: Object.assign(r.workspaces, {
        diffSince: (_path: string, head: string) => {
          expect(head).toBe("b".repeat(40));
          return { ok: true as const, value: "diff: added missing error case" };
        },
      }),
    },
    dispatchInput({
      quality: { policy: "task-default", step: "review", steps: ["review"], round: 2 },
    }),
  );
  expect(result.ok).toBe(true);
  expect(r.executor.started[0]?.prompt).toContain("previous FAIL: missing error case");
  expect(r.executor.started[0]?.prompt).toContain("diff: added missing error case");
});

it("refuses a combined packet when the actual changed files touch a gate", async () => {
  const r = rig();
  const workspaces = Object.assign(r.workspaces, {
    changedPaths: () => ({ ok: true as const, value: ["src/domain/approvals/approval-policy.ts"] }),
  });
  expect(
    await dispatchStep(
      { ...r.deps, workspaces },
      dispatchInput({
        quality: { policy: "lean", step: "review", steps: ["verify", "review"], round: 1 },
      }),
    ),
  ).toMatchObject({
    ok: false,
    reason: "CONTEXT_REJECTED",
    detail: "RISK_REQUIRES_SEPARATE_WORKERS",
  });
  expect(r.executor.started).toHaveLength(0);
});

it("blocks repeated quality work without a previous verdict and delta", async () => {
  const r = rig();
  expect(
    await dispatchStep(
      r.deps,
      dispatchInput({ quality: { policy: "lean", step: "review", steps: ["review"], round: 2 } }),
    ),
  ).toMatchObject({
    ok: false,
    reason: "CONTEXT_REJECTED",
    detail: "PREVIOUS_VERDICT_OR_DELTA_MISSING",
  });
  expect(r.executor.started).toHaveLength(0);
  expect(r.workspaces.released).toEqual([1]);
});

it("refuses a high-complexity combined packet even without a changed-path reader", async () => {
  const r = rig();
  expect(
    await dispatchStep(
      r.deps,
      dispatchInput({
        task: { complexity: "high" },
        quality: { policy: "lean", step: "review", steps: ["verify", "review"], round: 1 },
      }),
    ),
  ).toMatchObject({
    ok: false,
    reason: "CONTEXT_REJECTED",
    detail: "RISK_REQUIRES_SEPARATE_WORKERS",
  });
  expect(r.executor.started).toHaveLength(0);
});

async function verifiedQaForSeparateReview() {
  const r = rig();
  r.steps.rows.set("step-1", { ...r.steps.must("step-1"), stepId: "verify" });
  let checksRun = 0;
  const checks = {
    has: () => true,
    run: (request: { artifactRoot: string }) => {
      checksRun += 1;
      const evidence = r.artifacts.publish(
        `${request.artifactRoot}/checks/project-check.json`,
        "QA script log: passed",
      );
      return Promise.resolve({
        checkId: "project-check",
        status: "passed" as const,
        exitCode: 0,
        command: ["npm", "run", "check"],
        startedAt: "2026-11-11T00:00:00.000Z",
        endedAt: "2026-11-11T00:00:01.000Z",
        revision: "a".repeat(40),
        evidence,
      });
    },
  };
  const catalog = {
    ...r.deps.catalog,
    roles: [
      ...r.deps.catalog.roles,
      ...["qa", "reviewer"].map((id) => ({ definition: { ...role, id }, sha256: h("1") })),
    ],
  };
  const qa = dispatched(
    await dispatchStep(
      { ...r.deps, catalog, checks },
      dispatchInput({
        role: "qa",
        quality: { policy: "strict", step: "verify", steps: ["verify"], round: 1 },
        requiredChecks: ["project-check"],
      }),
    ),
  );
  const qaProof = skillEvidence(qa.attempt, (path, bytes) => r.artifacts.publish(path, bytes));
  expect(
    recordStepResult(
      { ...r.deps, checks },
      {
        attemptId: qa.attempt.id,
        execution: await r.executor.collectResult(qa.handle),
        checkRuns: qa.contextPacket.checkEvidence,
        result: {
          schemaVersion: 1,
          runId: "run-1",
          stepId: "verify",
          attemptId: qa.attempt.id,
          status: "succeeded",
          summary: "QA accepted script evidence",
          artifacts: qaProof.artifacts,
          revision: { headSha: HEAD, baseSha: BASE },
          checks: [],
          skillsApplied: qaProof.skillsApplied,
          findings: [],
        },
      },
    ),
  ).toMatchObject({ ok: true, stepStatus: "succeeded" });
  r.steps.rows.set("review-step", {
    id: "review-step",
    runId: "run-1",
    stepId: "review",
    status: "ready",
    version: 1,
  });
  const attempts = Object.assign(r.attempts, {
    latestForRunStep: (runId: string, stepId: string) =>
      runId === "run-1" && stepId === "verify" ? r.attempts.get(qa.attempt.id) : undefined,
  });
  const input = dispatchInput({
    stepRunId: "review-step",
    role: "reviewer",
    quality: { policy: "strict", step: "review", steps: ["review"], round: 1 },
    requiredChecks: [],
    checkEvidenceSteps: ["verify"],
  });
  return {
    r,
    qa,
    deps: { ...r.deps, catalog, attempts, checks },
    input,
    checksRun: () => checksRun,
  };
}

it("forwards preceding QA hashed check evidence to a separate runtime reviewer without rerunning", async () => {
  const s = await verifiedQaForSeparateReview();
  const review = dispatched(await dispatchStep(s.deps, s.input));
  expect(review.contextPacket.checkEvidence).toHaveLength(1);
  expect(review.contextPacket.checkEvidence?.[0]?.evidence.sha256).toBe(
    s.qa.contextPacket.checkEvidence?.[0]?.evidence.sha256,
  );
  expect(review.attempt.requiredChecks).toContain("project-check");
  expect(s.r.executor.started.at(-1)?.prompt).toContain("QA script log: passed");
  expect(review.contextPacket.role).toBe("reviewer");
  const proof = skillEvidence(review.attempt, (path, bytes) => s.r.artifacts.publish(path, bytes));
  expect(
    recordStepResult(s.deps, {
      attemptId: review.attempt.id,
      execution: await s.r.executor.collectResult(review.handle),
      checkRuns: review.contextPacket.checkEvidence,
      result: {
        schemaVersion: 1,
        runId: "run-1",
        stepId: "review",
        attemptId: review.attempt.id,
        status: "succeeded",
        summary: "Independent review",
        artifacts: proof.artifacts,
        revision: { headSha: HEAD, baseSha: BASE },
        checks: [],
        skillsApplied: proof.skillsApplied,
        findings: [],
      },
    }),
  ).toMatchObject({ ok: true, stepStatus: "succeeded" });
  expect(s.checksRun()).toBe(1);
});

it.each(["stale-sha", "corrupt-log", "failed-qa"])(
  "rejects %s evidence before starting a separate reviewer",
  async (mode) => {
    const s = await verifiedQaForSeparateReview();
    if (mode === "stale-sha") s.r.workspaces.headSha = "b".repeat(40);
    if (mode === "failed-qa") s.r.attempts.setStatus(s.qa.attempt.id, "failed");
    if (mode === "corrupt-log") {
      const path = s.qa.contextPacket.checkEvidence?.[0]?.evidence.path;
      if (path === undefined) throw new Error("missing check log");
      s.r.artifacts.files.set(path, new TextEncoder().encode("tampered log"));
    }
    expect(await dispatchStep(s.deps, s.input)).toMatchObject({
      ok: false,
      reason: "CONTEXT_REJECTED",
      detail: "QA_CHECK_EVIDENCE_INVALID",
    });
    expect(s.r.executor.started).toHaveLength(1);
    expect(s.checksRun()).toBe(1);
  },
);

describe("rework skills at the common dispatch boundary", () => {
  const skillIds = async (
    quality: Parameters<typeof dispatchInput>[0] extends infer O ? O : never,
  ) => {
    const r = rig();
    const result = dispatched(await dispatchStep(r.deps, dispatchInput(quality)));
    return result.attempt.skills.map((s) => s.id);
  };
  const q = (step: string, round: number) => ({
    quality: { policy: "task-default", step, steps: [step], round },
  });

  it("first dispatch does not carry receiving-code-review", async () => {
    expect(await skillIds({ stepSkills: ["debugging"], ...q("implement", 1) })).not.toContain(
      "receiving-code-review",
    );
  });

  it("an implement rework round carries the step skills plus receiving-code-review", async () => {
    expect(await skillIds({ stepSkills: ["debugging"], ...q("implement", 2) })).toEqual(
      expect.arrayContaining(["debugging", "tdd", "receiving-code-review"]),
    );
  });

  it("a non-implement round does not get the rework skill", async () => {
    expect(await skillIds({ stepSkills: ["debugging"], ...q("analyze", 2) })).not.toContain(
      "receiving-code-review",
    );
  });
});
