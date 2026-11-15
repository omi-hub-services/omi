import type { CheckpointManifest } from "../../../../../src/application/contracts/checkpoint.ts";
import type {
  CheckpointStore,
  CheckpointSave,
  CheckpointProblem,
} from "../../../../../src/application/ports/checkpoint-store.ts";
import type { ProjectSession } from "../../../../../src/application/ports/lease-store.ts";
import type {
  RecoveryRun,
  WorkerState,
} from "../../../../../src/application/ports/run-recovery.ts";
import type { ResumeRunDependencies } from "../../../../../src/application/use-cases/runs/resume-run.ts";
import { harness } from "../sync/outbox-fakes.ts";
import { h, rig, sha } from "./run-fakes.ts";

export function manifest(): CheckpointManifest {
  return {
    schemaVersion: 1,
    checkpointId: "cp-1",
    runId: "run-1",
    stepRunId: "step-1",
    stepId: "implement",
    kind: "pause",
    createdAt: "2026-11-11T00:00:00.000Z",
    hashes: { config: h("1"), template: h("2"), skills: [], rules: [] },
    taskSnapshot: { issueNumber: 32, title: "Recovery", body: "Resume." },
    acceptanceCriteria: ["works"],
    businessBaselineHash: h("9"),
    counters: { retryCount: 1 },
    decisions: [],
    approvalRefs: [],
    outputs: [],
    git: { worktreePath: "/work/omi-027", headSha: "a".repeat(40), branch: null, dirty: false },
    uncommitted: { entries: [], truncated: false, excludedCredentialPaths: 0 },
    previousFindings: [],
    nextAction: { action: "dispatch-step", stepId: "implement" },
  };
}

export function recoveryRig() {
  const r = rig("paused");
  const sync = harness();
  const state = {
    run: { id: "run-1", status: "paused", version: 1 } as RecoveryRun,
    lock: true,
    worker: "stopped" as WorkerState,
    gates: true,
    checkpoint: manifest() as CheckpointManifest | undefined,
    problems: [] as CheckpointProblem[],
    dispatches: [] as string[],
    order: [] as string[],
  };
  const records = new Map<string, CheckpointSave>();
  const checkpoints: CheckpointStore = {
    save(input) {
      records.set(input.id, input);
      return {
        ...input,
        stepRunId: input.stepRunId,
        gitRevision: input.gitRevision,
        manifestPath: `checkpoints/run-1/${input.id}.json`,
        manifestHash: sha(new TextDecoder().decode(input.bytes)),
        status: "valid",
      };
    },
    get: () => undefined,
    reconcile: () => {
      state.order.push("checkpoint");
      return { interrupted: [], orphanFiles: [], problems: state.problems };
    },
    latestValid: () => {
      if (state.checkpoint === undefined) return undefined;
      const cp = state.checkpoint;
      return {
        record: {
          id: cp.checkpointId,
          runId: cp.runId,
          stepRunId: cp.stepRunId,
          kind: cp.kind,
          manifestPath: "checkpoints/run-1/cp-1.json",
          manifestHash: sha(JSON.stringify(cp)),
          gitRevision: cp.git.headSha,
          status: "valid",
          createdAt: cp.createdAt,
        },
        bytes: new TextEncoder().encode(JSON.stringify(cp)),
      };
    },
  };
  const session: ProjectSession = {
    lease: {
      resourceKey: "project-owner",
      owner: "session-1",
      generation: 1,
      acquiredAt: "2026-11-11T00:00:00.000Z",
      expiresAt: "2026-11-12T00:00:00.000Z",
    },
    renew: () => state.lock,
    release: () => {
      state.lock = false;
    },
    record: () => undefined,
    commit(change) {
      if (!state.lock) return { ok: false, reason: "STALE_LEASE" };
      if (change.target.kind === "workflow_run") {
        if (change.target.expectedVersion !== state.run.version)
          return { ok: false, reason: "STALE_VERSION" };
        state.run = {
          ...state.run,
          status: change.target.toStatus,
          version: state.run.version + 1,
        };
        return { ok: true, newVersion: state.run.version, eventSequence: 1 };
      }
      return r.unitOfWork.commit({ ...change, at: "2026-11-11T00:00:00.000Z" });
    },
  };
  const deps: ResumeRunDependencies = {
    session,
    checkpoints,
    runs: {
      get: (id) => (id === state.run.id ? state.run : undefined),
      listSteps: () => [...r.steps.rows.values()],
    },
    attempts: r.attempts,
    workspaces: r.workspaces,
    artifacts: r.artifacts,
    processes: {
      inspect: () => {
        state.order.push("process");
        return state.worker;
      },
      stopOwned: () => {
        state.order.push("stop");
        state.worker = "stopped";
        return Promise.resolve();
      },
    },
    github: sync.deps,
    validateGates: () => {
      state.order.push("gates");
      return Promise.resolve(
        state.gates ? { ok: true } : { ok: false, reason: "APPROVAL_EXPIRED" },
      );
    },
    dispatch: (_cp, step) => {
      state.order.push("dispatch");
      state.dispatches.push(step.id);
      return Promise.resolve({ ok: true, attemptId: "next-attempt" });
    },
    now: r.deps.now,
    nextId: r.deps.nextId,
  };
  return { r, sync, state, checkpoints, records, session, deps };
}
