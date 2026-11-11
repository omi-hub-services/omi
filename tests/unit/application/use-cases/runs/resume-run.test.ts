import { describe, expect, it, vi } from "vitest";
import { resumeRun } from "../../../../../src/application/use-cases/runs/resume-run.ts";
import { dispatchStep } from "../../../../../src/application/use-cases/runs/dispatch-step.ts";
import { GitWorkspaceError } from "../../../../../src/application/ports/git-workspace.ts";
import { enqueue } from "../sync/outbox-fakes.ts";
import { recoveryRig } from "./recovery-fakes.ts";
import { dispatchInput, h } from "./run-fakes.ts";

async function withAttempt() {
  const setup = recoveryRig();
  const step = setup.r.steps.must("step-1");
  setup.r.steps.rows.set(step.id, { ...step, status: "ready" });
  const result = await dispatchStep(setup.r.deps, dispatchInput());
  if (!result.ok) throw new Error(result.reason);
  return { ...setup, attempt: result.attempt };
}

describe("resumeRun", () => {
  it("revalidates current gates and resumes a paused step from the manifest", async () => {
    const { deps, state, r } = recoveryRig();
    const result = await resumeRun(deps, { runId: "run-1" });
    expect(result).toMatchObject({
      ok: true,
      checkpoint: { counters: { retryCount: 1 } },
      stepRunId: "step-1",
    });
    expect(state.order).toEqual(["checkpoint", "gates", "dispatch"]);
    expect(state.run.status).toBe("running");
    expect(r.steps.must("step-1").status).toBe("ready");
  });

  it.each(["owned-running", "unowned-running", "unknown"] as const)(
    "refuses %s workers before reading files or releasing writers",
    async (worker) => {
      const { deps, state, r } = await withAttempt();
      state.worker = worker;
      expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({
        ok: false,
        reason:
          worker === "owned-running"
            ? "WORKER_STILL_RUNNING"
            : worker === "unowned-running"
              ? "WORKER_NOT_OWNED"
              : "WORKER_IDENTITY_UNKNOWN",
      });
      expect(state.order).toEqual(["process"]);
      expect(r.workspaces.released).toEqual([]);
    },
  );

  it("interrupts a dead attempt, releases its exact reservation, and readies the unfinished step", async () => {
    const { deps, state, r, attempt } = await withAttempt();
    expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({ ok: true });
    expect(r.attempts.get(attempt.id)?.status).toBe("interrupted");
    expect(r.workspaces.released).toEqual([attempt.workspace.generation]);
    expect(state.order).toEqual(["process", "checkpoint", "gates", "dispatch"]);
  });

  it("does not rerun an accepted step even if the checkpoint still requests it", async () => {
    const { deps, state, r } = recoveryRig();
    const step = r.steps.must("step-1");
    r.steps.rows.set(step.id, { ...step, status: "succeeded" });
    expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({ ok: true });
    expect(state.dispatches).toEqual([]);
    expect(r.steps.must(step.id)).toEqual({ ...step, status: "succeeded" });
  });

  it("reports missing checkpoints and every typed reconciliation problem", async () => {
    const { deps, state } = recoveryRig();
    state.checkpoint = undefined;
    state.problems = [{ checkpointId: "bad", reason: "CHECKPOINT_HASH_MISMATCH" }];
    expect(await resumeRun(deps, { runId: "run-1" })).toEqual({
      ok: false,
      reason: "CHECKPOINT_MISSING",
      checkpointProblems: state.problems,
    });
    expect(state.dispatches).toEqual([]);
  });

  it.each(["missing", "changed"])("reports %s output artifacts", async (fault) => {
    const { deps, state, r } = recoveryRig();
    const output = r.artifacts.publish("reports/output.md", "accepted");
    if (state.checkpoint === undefined) throw new Error("checkpoint missing");
    state.checkpoint.outputs = [{ ...output, size: 8 }];
    if (fault === "missing") r.artifacts.files.delete(output.path);
    else r.artifacts.publish(output.path, "altered");
    expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: fault === "missing" ? "ARTIFACT_MISSING" : "ARTIFACT_HASH_MISMATCH",
    });
    expect(state.dispatches).toEqual([]);
  });

  it.each(["head", "branch", "path", "dirty"])("refuses Git %s drift", async (field) => {
    const { deps, r } = recoveryRig();
    const inspect = r.workspaces.inspect.bind(r.workspaces);
    r.workspaces.inspect = (path) => {
      const result = inspect(path);
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          ...result.value,
          ...(field === "head"
            ? { headSha: "b".repeat(40) }
            : field === "branch"
              ? { branch: "other" }
              : field === "path"
                ? { path: "/other" }
                : { dirty: true }),
        },
      };
    };
    expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "GIT_MISMATCH",
    });
  });

  it("does not silently accept bounded or unhashed worktree manifests", async () => {
    const { deps, r } = recoveryRig();
    r.workspaces.uncommitted = { entries: [], truncated: true, excludedCredentialPaths: 0 };
    expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "UNCOMMITTED_UNVERIFIABLE",
    });
  });

  it("detects uncommitted content drift without resetting files", async () => {
    const { deps, r } = recoveryRig();
    r.workspaces.uncommitted.entries.push({
      path: "src/file.ts",
      status: "untracked",
      staged: false,
      sha256: h("a"),
      size: 1,
    });
    expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "UNCOMMITTED_MISMATCH",
    });
  });

  it("does not resume when Git is unavailable", async () => {
    const { deps, r } = recoveryRig();
    r.workspaces.inspect = () => ({ ok: false, error: new GitWorkspaceError("NOT_FOUND") });
    expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "WORKSPACE_UNAVAILABLE",
      detail: "NOT_FOUND",
    });
  });

  it.each(["waiting", "unavailable", "unreadable"])(
    "blocks unresolved remote outcomes: %s",
    async (outcome) => {
      const { deps, sync, state } = recoveryRig();
      enqueue(sync.outbox, sync.artifacts, "pr:task-1", { state: "outcome_unknown" });
      if (outcome === "unavailable")
        sync.github.lookupScript.push({ kind: "unavailable", code: "OFFLINE" });
      if (outcome === "unreadable")
        deps.github.artifacts.read = () => {
          throw new Error("missing");
        };
      expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({
        ok: false,
        reason: "GITHUB_UNRESOLVED",
      });
      expect(state.dispatches).toEqual([]);
      expect(sync.github.sends).toEqual([]);
    },
  );

  it("settles a found marker before checking current approvals", async () => {
    const { deps, sync, state } = recoveryRig();
    enqueue(sync.outbox, sync.artifacts, "pr:task-1", { state: "in_flight" });
    sync.github.lookupScript.push({ kind: "found", remoteIdentity: "pr:1" });
    state.gates = false;
    expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "GATE_INVALID",
      detail: "APPROVAL_EXPIRED",
    });
    expect(sync.outbox.state("pr:task-1")).toBe("succeeded");
    expect(state.dispatches).toEqual([]);
    expect(state.run.status).toBe("paused");
  });

  it("checks the project lock before any recovery work", async () => {
    const { deps, state } = recoveryRig();
    state.lock = false;
    expect(await resumeRun(deps, { runId: "run-1" })).toEqual({
      ok: false,
      reason: "PROJECT_LOCK_LOST",
    });
    expect(state.order).toEqual([]);
  });

  it("refuses lock loss during an awaited gate", async () => {
    const { deps, state } = recoveryRig();
    const validateGates = vi.fn(() => {
      state.lock = false;
      return Promise.resolve({ ok: true as const });
    });
    expect(await resumeRun({ ...deps, validateGates }, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "PROJECT_LOCK_LOST",
    });
    expect(state.dispatches).toEqual([]);
  });
  it("rejects a checkpoint that references a different step identity", async () => {
    const { deps, state } = recoveryRig();
    if (state.checkpoint === undefined) throw new Error("checkpoint missing");
    state.checkpoint.stepId = "review";
    expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "CHECKPOINT_INVALID",
    });
    expect(state.dispatches).toEqual([]);
  });

  it("rejects an unknown checkpoint attempt rather than guessing its provenance", async () => {
    const { deps, state } = recoveryRig();
    if (state.checkpoint === undefined) throw new Error("checkpoint missing");
    state.checkpoint.attemptId = "unknown-attempt";
    state.checkpoint.attemptNumber = 1;
    expect(await resumeRun(deps, { runId: "run-1" })).toMatchObject({
      ok: false,
      reason: "CHECKPOINT_INVALID",
    });
    expect(state.dispatches).toEqual([]);
  });
});
