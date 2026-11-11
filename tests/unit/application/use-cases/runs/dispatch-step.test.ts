import { describe, expect, it } from "vitest";
import { contextPacketSchema } from "../../../../../src/application/contracts/context.ts";
import { GitWorkspaceError } from "../../../../../src/application/ports/git-workspace.ts";
import {
  dispatchStep,
  type DispatchStepResult,
} from "../../../../../src/application/use-cases/runs/dispatch-step.ts";
import { dispatchInput, h, rig } from "./run-fakes.ts";

function dispatched(result: DispatchStepResult) {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

describe("dispatchStep", () => {
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
