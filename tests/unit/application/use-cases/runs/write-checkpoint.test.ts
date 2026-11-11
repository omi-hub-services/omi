import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitWorkspaceError } from "../../../../../src/application/ports/git-workspace.ts";
import { CheckpointError } from "../../../../../src/application/ports/checkpoint-store.ts";
import type {
  CheckpointRecord,
  CheckpointSave,
  CheckpointStore,
} from "../../../../../src/application/ports/checkpoint-store.ts";
import type { BoundaryCheckpointHook } from "../../../../../src/application/ports/checkpoint-hook.ts";
import { dispatchStep } from "../../../../../src/application/use-cases/runs/dispatch-step.ts";
import { recordStepResult } from "../../../../../src/application/use-cases/runs/record-step-result.ts";
import {
  writeCheckpoint,
  type WriteCheckpointDependencies,
} from "../../../../../src/application/use-cases/runs/write-checkpoint.ts";
import { checkpointManifestSchema } from "../../../../../src/application/contracts/checkpoint.ts";
import { dispatchInput, h, HEAD, BASE, rig, type Rig } from "./run-fakes.ts";

class FakeCheckpoints implements CheckpointStore {
  readonly saved: CheckpointSave[] = [];
  failWith: CheckpointError | undefined;
  save(input: CheckpointSave): CheckpointRecord {
    if (this.failWith !== undefined) throw this.failWith;
    this.saved.push(input);
    return {
      id: input.id,
      runId: input.runId,
      stepRunId: input.stepRunId,
      kind: input.kind,
      manifestPath: `checkpoints/${input.runId}/${input.id}.json`,
      manifestHash: createHash("sha256").update(input.bytes).digest("hex"),
      gitRevision: input.gitRevision,
      status: "valid",
      createdAt: input.createdAt,
    };
  }
  get(): undefined {
    return undefined;
  }
  latestValid(): undefined {
    return undefined;
  }
  reconcile() {
    return { interrupted: [], orphanFiles: [], problems: [] };
  }
  manifests() {
    return this.saved.map((s) =>
      checkpointManifestSchema.parse(JSON.parse(new TextDecoder().decode(s.bytes))),
    );
  }
}

function setup() {
  const r = rig();
  const checkpoints = new FakeCheckpoints();
  const deps: WriteCheckpointDependencies = {
    checkpoints,
    attempts: r.attempts,
    artifacts: r.artifacts,
    workspaces: r.workspaces,
    hasher: { sha256: (text) => createHash("sha256").update(text).digest("hex") },
    now: r.deps.now,
    nextId: () => `cp-${String(checkpoints.saved.length + 1)}`,
  };
  return { r, checkpoints, deps };
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-1",
    stepRunId: "step-1",
    stepId: "implement",
    kind: "before-dispatch",
    workspacePath: "/work/omi-026",
    hashes: { config: h("1"), template: h("2") },
    taskSnapshot: { issueNumber: 31, title: "Business checkpoint", body: "Do it." },
    acceptanceCriteria: ["works"],
    businessBaselineHash: h("9"),
    counters: { reworkCount: 0, retryCount: 1 },
    nextAction: { action: "dispatch-step", stepId: "implement" },
    ...overrides,
  };
}

describe("writeCheckpoint", () => {
  it("saves a manifest with git refs, the uncommitted manifest and verified output sizes", () => {
    const { r, checkpoints, deps } = setup();
    r.workspaces.uncommitted = {
      entries: [{ path: "src/a.ts", status: "untracked", staged: false, sha256: h("d"), size: 3 }],
      truncated: false,
      excludedCredentialPaths: 1,
    };
    const output = r.artifacts.publish("attempts/a1/report.md", "done");

    const result = writeCheckpoint(deps, input({ kind: "after-output", outputs: [output] }));

    expect(result.ok).toBe(true);
    const manifest = checkpoints.manifests()[0];
    expect(manifest).toMatchObject({
      checkpointId: "cp-1",
      kind: "after-output",
      git: { headSha: HEAD, branch: null, dirty: false },
      counters: { reworkCount: 0, retryCount: 1 },
      outputs: [{ path: output.path, sha256: output.sha256, size: 4 }],
      uncommitted: { excludedCredentialPaths: 1 },
    });
    expect(manifest?.uncommitted.entries).toHaveLength(1);
    expect(checkpoints.saved[0]?.gitRevision).toBe(HEAD);
  });

  it("takes skills and rules from the attempt when one is named", async () => {
    const { r, checkpoints, deps } = setup();
    const dispatch = await dispatchStep(r.deps, dispatchInput());
    if (!dispatch.ok) throw new Error(dispatch.reason);

    const result = writeCheckpoint(deps, input({ attemptId: dispatch.attempt.id }));

    expect(result.ok).toBe(true);
    const manifest = checkpoints.manifests()[0];
    expect(manifest?.attemptNumber).toBe(1);
    expect(manifest?.hashes.skills).toEqual(dispatch.attempt.skills);
    expect(manifest?.hashes.rules).toEqual(dispatch.attempt.rules);
  });

  it("refuses without writing anything", async () => {
    const { r, checkpoints, deps } = setup();
    expect(writeCheckpoint(deps, input({ runId: "" }))).toEqual({
      ok: false,
      reason: "INVALID_INPUT",
    });
    expect(writeCheckpoint(deps, input({ attemptId: "nope" }))).toEqual({
      ok: false,
      reason: "ATTEMPT_NOT_FOUND",
    });
    const dispatch = await dispatchStep(r.deps, dispatchInput());
    if (!dispatch.ok) throw new Error(dispatch.reason);
    expect(
      writeCheckpoint(deps, input({ attemptId: dispatch.attempt.id, runId: "other" })),
    ).toEqual({
      ok: false,
      reason: "ATTEMPT_MISMATCH",
    });
    expect(
      writeCheckpoint(
        deps,
        input({ outputs: [{ path: "attempts/x/missing.md", sha256: h("e") }] }),
      ),
    ).toEqual({ ok: false, reason: "OUTPUT_INVALID", detail: "NOT_FOUND" });
    r.workspaces.inspect = () => ({ ok: false, error: new GitWorkspaceError("NOT_FOUND") });
    expect(writeCheckpoint(deps, input())).toMatchObject({
      ok: false,
      reason: "WORKSPACE_UNAVAILABLE",
    });
    expect(checkpoints.saved).toEqual([]);
  });

  it("refuses a manifest that would carry a credential, and saves nothing", () => {
    const { checkpoints, deps } = setup();
    const result = writeCheckpoint(
      deps,
      input({ taskSnapshot: { issueNumber: 1, title: "t", body: "use ghp_abcdefghijklmnop1234" } }),
    );
    expect(result).toEqual({ ok: false, reason: "CREDENTIAL_REJECTED" });
    expect(checkpoints.saved).toEqual([]);
  });

  it("reports a store failure as WRITE_FAILED with the fixed code", () => {
    const { checkpoints, deps } = setup();
    checkpoints.failWith = new CheckpointError("ALREADY_EXISTS");
    expect(writeCheckpoint(deps, input())).toEqual({
      ok: false,
      reason: "WRITE_FAILED",
      detail: "ALREADY_EXISTS",
    });
  });
});

describe("checkpoints at step boundaries", () => {
  function hooked(r: Rig, checkpoints: FakeCheckpoints, deps: WriteCheckpointDependencies) {
    const events: Parameters<BoundaryCheckpointHook>[0][] = [];
    /** What the state looked like at the moment each snapshot was requested. */
    const seen: { attempts: number; step: string | undefined }[] = [];
    const hook: BoundaryCheckpointHook = (event) => {
      events.push(event);
      seen.push({ attempts: r.attempts.rows.size, step: r.steps.rows.get("step-1")?.status });
      return writeCheckpoint(deps, input({ ...event }));
    };
    return { events, seen, deps: { ...r.deps, checkpoint: hook }, checkpoints };
  }

  it("dispatch snapshots before any attempt exists, and again after the confirmed output", async () => {
    const { r, checkpoints, deps } = setup();
    const wired = hooked(r, checkpoints, deps);

    const dispatch = await dispatchStep(wired.deps, dispatchInput());
    if (!dispatch.ok) throw new Error(dispatch.reason);
    expect(wired.events.map((e) => e.kind)).toEqual(["before-dispatch"]);
    expect(wired.events[0]?.workspacePath).toBe("/work/omi-017");
    expect(wired.checkpoints.saved).toHaveLength(1);
    // Nothing had been dispatched when the snapshot was requested.
    expect(wired.seen[0]).toEqual({ attempts: 0, step: "ready" });

    const root = `attempts/${dispatch.attempt.id}`;
    const artifact = r.artifacts.publish(`${root}/reports/implementation.md`, "done");
    r.artifacts.publish(`${root}/reports/unit-tests.txt`, "ok");
    const execution = await r.executor.collectResult(dispatch.handle);
    const recorded = recordStepResult(wired.deps, {
      attemptId: dispatch.attempt.id,
      execution,
      result: {
        schemaVersion: 1,
        runId: "run-1",
        stepId: "implement",
        attemptId: dispatch.attempt.id,
        status: "succeeded",
        summary: "Implemented.",
        artifacts: [artifact],
        revision: { headSha: HEAD, baseSha: BASE },
        checks: [{ id: "unit-tests", evidenceRef: `${root}/reports/unit-tests.txt` }],
        findings: [],
      },
    });

    expect(recorded).toEqual({ ok: true, stepStatus: "succeeded", attemptStatus: "succeeded" });
    expect(wired.events.map((e) => e.kind)).toEqual(["before-dispatch", "after-output"]);
    // The outcome was already committed and the writer released when it was requested.
    expect(wired.seen[1]).toEqual({ attempts: 1, step: "succeeded" });
    expect(wired.checkpoints.manifests()[1]).toMatchObject({
      kind: "after-output",
      attemptId: dispatch.attempt.id,
      outputs: [{ path: artifact.path, sha256: artifact.sha256 }],
    });
  });

  it("a failed before-dispatch checkpoint refuses the dispatch and releases the writer", async () => {
    const { r, checkpoints, deps } = setup();
    checkpoints.failWith = new CheckpointError("INCONSISTENT");
    const wired = hooked(r, checkpoints, deps);

    const dispatch = await dispatchStep(wired.deps, dispatchInput());

    expect(dispatch).toEqual({ ok: false, reason: "CHECKPOINT_FAILED", detail: "WRITE_FAILED" });
    expect(r.steps.must("step-1").status).toBe("ready");
    expect(r.attempts.rows.size).toBe(0);
    expect(r.workspaces.released).toEqual([1]);
    expect(r.executor.started).toEqual([]);
  });

  it("a failed after-output checkpoint is reported but does not undo the recorded outcome", async () => {
    const { r, checkpoints, deps } = setup();
    const wired = hooked(r, checkpoints, deps);
    const dispatch = await dispatchStep(wired.deps, dispatchInput());
    if (!dispatch.ok) throw new Error(dispatch.reason);
    checkpoints.failWith = new CheckpointError("INCONSISTENT");

    const execution = await r.executor.collectResult(dispatch.handle);
    const recorded = recordStepResult(wired.deps, { attemptId: dispatch.attempt.id, execution });

    expect(recorded).toEqual({
      ok: true,
      stepStatus: "failed",
      attemptStatus: "failed",
      failure: "RESULT_MISSING",
      checkpointFailure: "WRITE_FAILED",
    });
    expect(r.steps.must("step-1").status).toBe("failed");
  });

  it("without a hook behaves exactly as before", async () => {
    const r = rig();
    const dispatch = await dispatchStep(r.deps, dispatchInput());
    expect(dispatch.ok).toBe(true);
  });
});
