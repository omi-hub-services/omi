import { createHash } from "node:crypto";
import { roleSchema } from "../../../../../src/application/contracts/role.ts";
import type {
  ExecutionEvent,
  ExecutionHandle,
  ExecutionRequest,
  ExecutionResult,
  ProbeResult,
} from "../../../../../src/application/contracts/agent-execution.ts";
import type {
  ArtifactReference,
  ArtifactWrite,
} from "../../../../../src/application/contracts/artifact.ts";
import type { UncommittedManifest } from "../../../../../src/application/contracts/checkpoint.ts";
import type { ResolutionCatalog } from "../../../../../src/application/contracts/resolution-catalog.ts";
import type { AgentExecutor } from "../../../../../src/application/ports/agent-executor.ts";
import { AgentExecutorError } from "../../../../../src/application/ports/agent-executor.ts";
import type {
  AttemptRecord,
  AttemptStore,
  StepRunReader,
  StepRunRecord,
} from "../../../../../src/application/ports/attempt-store.ts";
import { ArtifactError } from "../../../../../src/application/ports/artifact-store.ts";
import type { ArtifactStore } from "../../../../../src/application/ports/artifact-store.ts";
import type {
  GitWorkspace,
  GitWorkspaceResult,
  TaskWorkspace,
  WorkspaceState,
} from "../../../../../src/application/ports/git-workspace.ts";
import { GitWorkspaceError } from "../../../../../src/application/ports/git-workspace.ts";
import type { Lease } from "../../../../../src/application/ports/lease-store.ts";
import type {
  StateChange,
  StateCommitResult,
  StateUnitOfWork,
} from "../../../../../src/application/ports/state-unit-of-work.ts";
import type { AgentAttemptStatus } from "../../../../../src/domain/runs/agent-attempt.ts";

export const h = (c: string): string => c.repeat(64);
export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);

export const role = roleSchema.parse({
  schema_version: 1,
  id: "developer",
  version: 3,
  title: "Developer",
  description: "Implements.",
  skills: ["tdd"],
  rules: ["architecture-boundaries"],
});

export function catalog(): ResolutionCatalog {
  return {
    roles: [{ definition: role, sha256: h("1") }],
    skills: [
      { id: "tdd", version: "1", sha256: h("a") },
      { id: "debugging", version: "1", sha256: h("c") },
    ],
    rules: [
      { id: "architecture-boundaries", version: "1", sha256: h("d"), mandatory: false },
      { id: "project-baseline", version: "4", sha256: h("e"), mandatory: true },
    ],
  };
}

export class FakeSteps implements StepRunReader {
  readonly rows = new Map<string, StepRunRecord>();
  get(id: string): StepRunRecord | undefined {
    return this.rows.get(id);
  }
  /** Test helper: the row, which must exist. */
  must(id: string): StepRunRecord {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`no step ${id}`);
    return row;
  }
}

export class FakeAttempts implements AttemptStore {
  readonly rows = new Map<string, AttemptRecord>();
  create(record: AttemptRecord): void {
    this.rows.set(record.id, record);
  }
  get(id: string): AttemptRecord | undefined {
    return this.rows.get(id);
  }
  latestForStep(stepRunId: string): AttemptRecord | undefined {
    return [...this.rows.values()]
      .filter((row) => row.stepRunId === stepRunId)
      .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  }
  setStatus(id: string, status: AgentAttemptStatus): void {
    const row = this.rows.get(id);
    if (row !== undefined) this.rows.set(id, { ...row, status });
  }
}

/** Compare-and-swap on the step version and a lease fence, like the SQLite adapter. */
export class FakeUnitOfWork implements StateUnitOfWork {
  readonly commits: StateChange[] = [];
  private readonly steps: FakeSteps;
  private readonly leases: Map<string, Lease>;
  constructor(steps: FakeSteps, leases: Map<string, Lease>) {
    this.steps = steps;
    this.leases = leases;
  }
  commit(change: StateChange): StateCommitResult {
    if (change.fence !== undefined) {
      const lease = this.leases.get(change.fence.resourceKey);
      if (lease === undefined || lease.generation !== change.fence.generation) {
        return { ok: false, reason: "STALE_LEASE" };
      }
    }
    const target = change.target;
    if (target.kind !== "step_run") throw new Error("unexpected target");
    const row = this.steps.rows.get(target.id);
    if (row === undefined) return { ok: false, reason: "NOT_FOUND" };
    if (row.version !== target.expectedVersion) return { ok: false, reason: "STALE_VERSION" };
    this.steps.rows.set(row.id, { ...row, status: target.toStatus, version: row.version + 1 });
    this.commits.push(change);
    return { ok: true, newVersion: row.version + 1, eventSequence: this.commits.length };
  }
}

export class FakeArtifacts implements ArtifactStore {
  readonly files = new Map<string, Uint8Array>();
  write(input: ArtifactWrite): ArtifactReference {
    if (this.files.has(input.path)) throw new ArtifactError("ALREADY_EXISTS");
    this.files.set(input.path, input.bytes);
    return { path: input.path, sha256: createHash("sha256").update(input.bytes).digest("hex") };
  }
  /** Test helper: a file the worker published. */
  publish(path: string, text: string): ArtifactReference {
    this.files.set(path, new TextEncoder().encode(text));
    return { path, sha256: sha(text) };
  }
  read(reference: ArtifactReference): Uint8Array {
    const bytes = this.files.get(reference.path);
    if (bytes === undefined) throw new ArtifactError("NOT_FOUND");
    if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
      throw new ArtifactError("HASH_MISMATCH");
    }
    return bytes;
  }
  manifest(references: readonly ArtifactReference[]) {
    return {
      schemaVersion: 1 as const,
      artifacts: references.map((r) => ({ ...r, size: this.read(r).byteLength })),
    };
  }
}

export class FakeWorkspaces implements GitWorkspace {
  headSha = HEAD;
  failCreate: GitWorkspaceError | undefined;
  readonly leases = new Map<string, Lease>();
  readonly released: number[] = [];
  private generation = 0;
  createTask(request: { taskId: string; slug: string }): GitWorkspaceResult<TaskWorkspace> {
    if (this.failCreate !== undefined) return { ok: false, error: this.failCreate };
    return {
      ok: true,
      value: {
        taskId: request.taskId,
        slug: request.slug,
        path: `/work/${request.slug}`,
        branch: `task/${request.slug}`,
      },
    };
  }
  inspect(path: string): GitWorkspaceResult<WorkspaceState> {
    return {
      ok: true,
      value: { path, headSha: this.headSha, branch: null, dirty: false, hasIgnoredFiles: false },
    };
  }
  uncommitted: UncommittedManifest = { entries: [], truncated: false, excludedCredentialPaths: 0 };
  listUncommitted(): GitWorkspaceResult<UncommittedManifest> {
    return { ok: true, value: this.uncommitted };
  }
  acquireWriter(request: {
    slug: string;
    owner: string;
    now: string;
    expiresAt: string;
  }): GitWorkspaceResult<Lease> {
    const lease: Lease = {
      resourceKey: `worktree:${request.slug}`,
      owner: request.owner,
      generation: ++this.generation,
      acquiredAt: request.now,
      expiresAt: request.expiresAt,
    };
    this.leases.set(lease.resourceKey, lease);
    return { ok: true, value: lease };
  }
  renewWriter(): GitWorkspaceResult<Lease> {
    throw new Error("not used");
  }
  releaseWriter(request: { generation: number }): GitWorkspaceResult<void> {
    this.released.push(request.generation);
    return { ok: true, value: undefined };
  }
  removeTask(): GitWorkspaceResult<void> {
    throw new Error("not used");
  }
}

export class FakeExecutor implements AgentExecutor {
  readonly executor = "claude-code" as const;
  readonly started: ExecutionRequest[] = [];
  failStart = false;
  /** Builds the result for the attempt the way an adapter would report it. */
  outcome: ExecutionResult["outcome"] = "succeeded";
  exitCode = 0;
  probe(): Promise<ProbeResult> {
    throw new Error("not used");
  }
  start(request: ExecutionRequest): Promise<ExecutionHandle> {
    if (this.failStart) return Promise.reject(new AgentExecutorError("SPAWN_FAILED"));
    this.started.push(request);
    return Promise.resolve({
      executionId: `exec-${request.attemptId}`,
      attemptId: request.attemptId,
      executor: "claude-code",
    });
  }
  events(): AsyncIterable<ExecutionEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    };
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
  collectResult(handle: ExecutionHandle): Promise<ExecutionResult> {
    const request = this.started.find((r) => r.attemptId === handle.attemptId);
    if (request === undefined) throw new Error("unknown handle");
    return Promise.resolve({
      executionId: handle.executionId,
      attemptId: handle.attemptId,
      executor: "claude-code",
      outcome: this.outcome,
      exitCode: this.exitCode,
      signal: null,
      durationMs: 10,
      model: { requested: request.model },
      effort: { requested: request.effort },
      authMode: "subscription",
      toolsUsed: [],
      eventCount: 0,
      unparsedLines: 0,
      escalated: false,
      leftoverProcessesKilled: false,
    });
  }
}

export function dispatchInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    models: {
      schema_version: 1,
      models: {
        opus: { executor: "claude-code", model: "opus", supported_efforts: ["medium", "high"] },
      },
      capability_profiles: { standard: { min_effort: "medium" } },
      verified_models: { standard: ["opus"] },
    },
    stepRunId: "step-1",
    taskId: "OMI-017",
    slug: "omi-017",
    owner: "worker-1",
    role: "developer",
    requiredChecks: ["unit-tests"],
    execution: {
      profileHome: "/profiles/a",
      model: "opus",
      effort: "high",
      access: "workspace-write",
      timeoutMs: 60_000,
    },
    context: {
      taskSnapshot: { issueNumber: 20, title: "Dispatch", body: "Do it." },
      acceptanceCriteria: ["works"],
      businessBaselineHash: h("9"),
      capabilityProfile: { id: "standard", min_effort: "medium" },
      inputArtifacts: [],
      previousFindings: [],
      expectedOutputSchema: "step-result",
      allowedScope: { paths: ["src"] },
      approvalRefs: [],
    },
    ...overrides,
  };
}

export interface Rig {
  steps: FakeSteps;
  attempts: FakeAttempts;
  artifacts: FakeArtifacts;
  workspaces: FakeWorkspaces;
  executor: FakeExecutor;
  unitOfWork: FakeUnitOfWork;
  deps: {
    catalog: ResolutionCatalog;
    steps: FakeSteps;
    attempts: FakeAttempts;
    artifacts: FakeArtifacts;
    workspaces: FakeWorkspaces;
    executor: FakeExecutor;
    unitOfWork: FakeUnitOfWork;
    leaseTtlMs: number;
    now: () => number;
    nextId: () => string;
  };
}

export function rig(stepStatus: StepRunRecord["status"] = "ready"): Rig {
  const steps = new FakeSteps();
  steps.rows.set("step-1", {
    id: "step-1",
    runId: "run-1",
    stepId: "implement",
    status: stepStatus,
    version: 1,
  });
  const attempts = new FakeAttempts();
  const artifacts = new FakeArtifacts();
  const workspaces = new FakeWorkspaces();
  const executor = new FakeExecutor();
  const unitOfWork = new FakeUnitOfWork(steps, workspaces.leases);
  let n = 0;
  return {
    steps,
    attempts,
    artifacts,
    workspaces,
    executor,
    unitOfWork,
    deps: {
      catalog: catalog(),
      steps,
      attempts,
      artifacts,
      workspaces,
      executor,
      unitOfWork,
      leaseTtlMs: 60_000,
      now: () => Date.parse("2026-11-11T00:00:00.000Z"),
      nextId: () => `id-${String(++n)}`,
    },
  };
}
