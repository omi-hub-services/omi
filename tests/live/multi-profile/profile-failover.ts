// OMI-004 PoC support: move one step from a limited profile to another one and continue from a
// tool-independent checkpoint (architecture.md §7 "Failover subscription", §10; ADR-0005).
//
// Test-only. It composes existing pieces: an `AgentExecutor` adapter, the domain profile and
// step machines, the operational retry policy and the hash-pinned `ArtifactStore`. The
// production use case (`src/application/use-cases/profiles/failover-step.ts`) does not exist
// yet; this module is the evidence of what it must do, not a substitute for it.
//
// A limit has one of two sources and the trace always says which:
// - `cli-reported`: the adapter classified the run as `usage-limit` from the CLI's own output
//   (a real quota signal on a live run; a replayed fixture on the fake-CLI integration test);
// - `injected`: the harness declared a limit after a successful attempt. It spends no quota and
//   is never reported as quota detection.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  ExecutionEvent,
  ExecutionResult,
  ProbeResult,
} from "../../../src/application/contracts/agent-execution.js";
import type { ArtifactReference } from "../../../src/application/contracts/artifact.js";
import type { Effort } from "../../../src/application/contracts/model-capability.js";
import type { AgentExecutor } from "../../../src/application/ports/agent-executor.js";
import type { ArtifactStore } from "../../../src/application/ports/artifact-store.js";
import { evaluateProfileAvailability } from "../../../src/domain/profiles/availability-policy.js";
import {
  transitionProfile,
  type ProfileEvent,
  type ProfileState,
} from "../../../src/domain/profiles/profile-state.js";
import {
  decideOperationalRetry,
  type OperationalFailure,
  type RetryAction,
  type RetryBudget,
} from "../../../src/domain/runs/retry-policy.js";
import {
  transitionStep,
  type StepEvent,
  type StepStatus,
} from "../../../src/domain/runs/step-run.js";

export interface ProfileSlot {
  /** Registry id, e.g. `claude-minibox`. Never a path in evidence. */
  id: string;
  home: string;
  /** Profiles of one account share quota and go into cooldown together (architecture.md §7). */
  accountGroup: string;
}

export type LimitSource = "cli-reported" | "injected";

export interface TwoPartTask {
  /** Prompt of the first attempt. */
  firstPrompt: string;
  /**
   * What is left, read from the workspace by the harness (never from the worker's own claim);
   * `undefined` when the step's work is complete.
   */
  nextAction(workspace: string): string | undefined;
  /** Prompt of the continuation attempt, built only from the verified checkpoint. */
  continuationPrompt(checkpoint: CheckpointManifest): string;
}

export interface FailoverOptions {
  executor: AgentExecutor;
  /** Preference order. The first available profile runs the first attempt. */
  profiles: readonly ProfileSlot[];
  workspace: string;
  store: ArtifactStore;
  model: string;
  effort: Effort;
  timeoutMs: number;
  task: TwoPartTask;
  /** Declare a limit after attempt 1 if it succeeded. Spends no quota. */
  injectLimitAfterFirstAttempt?: boolean;
  /** Epoch ms. */
  now: () => number;
  /** Called after the checkpoint is stored and before the next profile is chosen. */
  afterCheckpoint?: () => void;
  runId?: string;
  stepId?: string;
}

const RETRY_BUDGET: RetryBudget = { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 900_000 };
const PROBE_TTL_MS = 10 * 60_000;

const fileEntrySchema = z.strictObject({
  path: z.string().min(1).max(512),
  /** `null` for a tracked file that no longer exists. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

export const checkpointManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  interruptedAttemptId: z.string().min(1),
  fromProfileId: z.string().min(1),
  limit: z.strictObject({
    source: z.enum(["cli-reported", "injected"]),
    limitType: z.string().optional(),
    resetsAt: z.number().int().optional(),
  }),
  gitHead: z.string().regex(/^[0-9a-f]{40}$/),
  files: z.array(fileEntrySchema),
  diff: z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  nextAction: z.string().min(1).max(2000),
  createdAt: z.iso.datetime({ precision: 3 }),
});
export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;

export interface AttemptTrace {
  attemptId: string;
  profileId: string;
  outcome: ExecutionResult["outcome"];
  reason?: string;
  authMode: ExecutionResult["authMode"];
  modelActual?: string;
  numTurns?: number;
  durationMs: number;
  toolsUsed: string[];
  quotaSignals: Extract<ExecutionEvent, { kind: "quota-signal" }>[];
  sessionId?: string;
}

export interface TransitionTrace {
  machine: "profile" | "step";
  subject: string;
  event: string;
  from: string;
  to?: string;
  refused?: string;
}

export type FailoverFinal =
  | "succeeded-after-failover"
  | "succeeded-without-limit"
  | "waiting-resource"
  | "stopped"
  | "checkpoint-invalid"
  | "continuation-failed";

export interface FailoverTrace {
  probes: { profileId: string; status: ProbeResult["status"]; version?: string }[];
  attempts: AttemptTrace[];
  limit?: { source: LimitSource; limitType?: string; resetsAt?: number };
  retryDecision?: RetryAction;
  checkpoint?: { manifest: ArtifactReference; diff: ArtifactReference; nextAction: string };
  checkpointVerified?: boolean;
  selectedForContinuation?: string;
  availability: { profileId: string; allowed: boolean; reasons?: readonly string[] }[];
  /** A late event of the interrupted attempt must not change the new attempt's step. */
  staleAttemptRefused?: boolean;
  transitions: TransitionTrace[];
  final: FailoverFinal;
  stepStatus: StepStatus;
}

interface ProfileRecord {
  slot: ProfileSlot;
  state: ProfileState;
  lastProbeAt?: number;
  cooldownUntil?: number;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(cwd: string, args: string[]): Buffer {
  const result = spawnSync("git", args, { cwd, timeout: 10_000, shell: false });
  if (result.status !== 0) throw new Error(`git ${args[0] ?? ""} failed in the PoC workspace`);
  return result.stdout;
}

/** Tracked and untracked (not ignored) files with their content hash. */
export function snapshotFiles(workspace: string): z.infer<typeof fileEntrySchema>[] {
  const listed = git(workspace, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
  return [...new Set(listed)].sort().map((path) => {
    let digest: string | null;
    try {
      digest = sha256(readFileSync(join(workspace, path)));
    } catch {
      digest = null;
    }
    return { path, sha256: digest };
  });
}

function failureOf(outcome: ExecutionResult["outcome"]): OperationalFailure | undefined {
  switch (outcome) {
    case "usage-limit":
      return "rate_limit";
    case "auth-required":
      return "login_required";
    case "unsupported-model-or-effort":
      return "invalid_config";
    case "cancelled":
    case "timed-out":
      return "process_died";
    case "succeeded":
      return undefined;
    case "malformed-output":
    case "failed":
      return "unclassified";
  }
}

/**
 * Runs the step on the first available profile; on a limit it stops, checkpoints, cools the
 * account group down, selects another available profile, verifies the checkpoint against the
 * workspace and starts a new attempt there from the checkpoint (not from a transcript).
 */
export async function runWithProfileFailover(options: FailoverOptions): Promise<FailoverTrace> {
  const runId = options.runId ?? "run-omi-004";
  const stepId = options.stepId ?? "step-continuation";
  const transitions: TransitionTrace[] = [];
  const trace: FailoverTrace = {
    probes: [],
    attempts: [],
    availability: [],
    transitions,
    final: "stopped",
    stepStatus: "pending",
  };

  const profiles: ProfileRecord[] = options.profiles.map((slot) => ({ slot, state: "unknown" }));

  const moveProfile = (record: ProfileRecord, event: ProfileEvent): void => {
    const outcome = transitionProfile(record.state, event);
    transitions.push({
      machine: "profile",
      subject: record.slot.id,
      event: event.type,
      from: record.state,
      ...(outcome.ok ? { to: outcome.to } : { refused: outcome.reason }),
    });
    if (outcome.ok) record.state = outcome.to;
  };

  // Widened on purpose: moveStep() changes it inside a closure, which narrowing cannot see.
  let step = "pending" as StepStatus;
  const moveStep = (event: StepEvent): boolean => {
    const outcome = transitionStep(step, event);
    transitions.push({
      machine: "step",
      subject: stepId,
      event: event.type,
      from: step,
      ...(outcome.ok ? { to: outcome.to } : { refused: outcome.reason }),
    });
    if (outcome.ok) step = outcome.to;
    trace.stepStatus = step;
    return outcome.ok;
  };

  // 1. Probe every profile (no model quota) and derive availability from the observation.
  for (const record of profiles) {
    const probe = await options.executor.probe({ profileHome: record.slot.home });
    trace.probes.push({
      profileId: record.slot.id,
      status: probe.status,
      ...(probe.version === undefined ? {} : { version: probe.version }),
    });
    if (probe.status === "ready") {
      moveProfile(record, { type: "probe_succeeded" });
      record.lastProbeAt = options.now();
    } else if (probe.status === "login-required") {
      moveProfile(record, { type: "login_failed" });
    } else {
      moveProfile(record, { type: "probe_failed" });
    }
  }

  const availableProfile = (): ProfileRecord | undefined => {
    trace.availability = profiles.map((record) => {
      const decision = evaluateProfileAvailability(
        {
          state: record.state,
          ...(record.lastProbeAt === undefined ? {} : { lastProbeAt: record.lastProbeAt }),
          ...(record.cooldownUntil === undefined ? {} : { cooldownUntil: record.cooldownUntil }),
          activeWorkers: 0,
          maxConcurrency: 1,
        },
        options.now(),
        PROBE_TTL_MS,
      );
      return {
        profileId: record.slot.id,
        allowed: decision.allowed,
        ...(decision.allowed ? {} : { reasons: decision.reasons }),
      };
    });
    return profiles.find(
      (record) =>
        trace.availability.find((entry) => entry.profileId === record.slot.id)?.allowed === true,
    );
  };

  const runAttempt = async (
    attemptId: string,
    record: ProfileRecord,
    prompt: string,
  ): Promise<ExecutionResult> => {
    const handle = await options.executor.start({
      attemptId,
      workspace: options.workspace,
      profileHome: record.slot.home,
      prompt,
      model: options.model,
      effort: options.effort,
      access: "workspace-write",
      timeoutMs: options.timeoutMs,
    });
    // collectResult resolves only after the process (group) has exited: the writer is stopped.
    const result = await options.executor.collectResult(handle);
    const quotaSignals: AttemptTrace["quotaSignals"] = [];
    for await (const event of options.executor.events(handle)) {
      if (event.kind === "quota-signal") quotaSignals.push(event);
    }
    trace.attempts.push({
      attemptId,
      profileId: record.slot.id,
      outcome: result.outcome,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      authMode: result.authMode,
      ...(result.model.actual === undefined ? {} : { modelActual: result.model.actual }),
      ...(result.numTurns === undefined ? {} : { numTurns: result.numTurns }),
      durationMs: result.durationMs,
      toolsUsed: result.toolsUsed,
      quotaSignals,
      ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    });
    return result;
  };

  const first = availableProfile();
  if (first === undefined) {
    trace.final = "waiting-resource";
    return trace;
  }

  // 2. Attempt 1 on the preferred profile.
  moveStep({ type: "dependencies_met", inputsValid: true, inScope: true });
  // The PoC owns its temporary workspace exclusively (lease) and the prompt is the saved context.
  moveStep({ type: "start", leaseHeld: true, executorEligible: true, contextSaved: true });
  const firstResult = await runAttempt("attempt-1", first, options.task.firstPrompt);

  // 3. Classify. Only a usage limit — reported or injected — leads to failover.
  let limit: FailoverTrace["limit"];
  if (firstResult.outcome === "usage-limit") {
    limit = {
      source: "cli-reported",
      ...(firstResult.quota?.limitType === undefined
        ? {}
        : { limitType: firstResult.quota.limitType }),
      ...(firstResult.quota?.resetsAt === undefined
        ? {}
        : { resetsAt: firstResult.quota.resetsAt }),
    };
  } else if (firstResult.outcome === "succeeded" && options.injectLimitAfterFirstAttempt === true) {
    limit = { source: "injected" };
  }
  const failure: OperationalFailure | undefined =
    limit === undefined ? failureOf(firstResult.outcome) : "rate_limit";

  if (failure === undefined) {
    const done = options.task.nextAction(options.workspace) === undefined;
    moveStep({
      type: "succeed",
      attempt: 1,
      currentAttempt: 1,
      resultValid: true,
      stepGatePassed: done,
    });
    trace.final = step === "succeeded" ? "succeeded-without-limit" : "stopped";
    return trace;
  }
  if (limit !== undefined) trace.limit = limit;

  const decision = decideOperationalRetry({
    failure,
    retriesMade: 0,
    now: options.now(),
    jitter: 0.5,
    budget: RETRY_BUDGET,
    ...(limit?.resetsAt === undefined ? {} : { cooldownUntil: limit.resetsAt * 1000 }),
  });
  trace.retryDecision = decision;
  if (decision.action !== "failover" || limit === undefined) {
    moveStep({ type: "fail", attempt: 1, currentAttempt: 1 });
    trace.final = "stopped";
    return trace;
  }

  // 4. The writer has stopped (process exited); the step waits for another resource.
  moveStep({ type: "wait_resource", attempt: 1, currentAttempt: 1, previousWriterStopped: true });

  // 5. Checkpoint from the filesystem: the agent itself cannot write one (architecture.md §7.2).
  const nextAction = options.task.nextAction(options.workspace) ?? "verify-complete";
  const createdAt = new Date(options.now()).toISOString();
  const diffBytes = git(options.workspace, ["diff", "--binary", "HEAD"]);
  // No `producerAttemptId`: it references `agent_attempts`, which this PoC does not persist.
  const diff = options.store.write({
    id: `${runId}.${stepId}.attempt-1.diff`,
    path: `runs/${runId}/${stepId}/attempt-1.diff`,
    bytes: new Uint8Array(diffBytes),
    classification: "checkpoint-diff",
    createdAt,
  });
  const manifest: CheckpointManifest = {
    schemaVersion: 1,
    runId,
    stepId,
    interruptedAttemptId: "attempt-1",
    fromProfileId: first.slot.id,
    limit,
    gitHead: git(options.workspace, ["rev-parse", "HEAD"]).toString("utf8").trim(),
    files: snapshotFiles(options.workspace),
    diff,
    nextAction,
    createdAt,
  };
  const manifestRef = options.store.write({
    id: `${runId}.${stepId}.checkpoint-1`,
    path: `runs/${runId}/${stepId}/checkpoint-1.json`,
    bytes: Buffer.from(JSON.stringify(manifest, null, 2)),
    classification: "checkpoint",
    createdAt,
  });
  trace.checkpoint = { manifest: manifestRef, diff, nextAction };
  options.afterCheckpoint?.();

  // 6. Cool down every profile of the limited account group.
  for (const record of profiles) {
    if (record.slot.accountGroup !== first.slot.accountGroup) continue;
    moveProfile(record, {
      type: "limit_hit",
      now: options.now(),
      cooldownUntil: decision.cooldownUntil,
    });
    record.cooldownUntil = decision.cooldownUntil;
  }

  // 7. Select another profile; none left means waiting_resource, never a silent downgrade.
  const next = availableProfile();
  if (next === undefined) {
    trace.final = "waiting-resource";
    return trace;
  }
  trace.selectedForContinuation = next.slot.id;

  // 8. Reconcile: read the manifest back (hash-pinned) and compare it with the workspace.
  let verified: CheckpointManifest | undefined;
  try {
    const parsed = checkpointManifestSchema.parse(
      JSON.parse(Buffer.from(options.store.read(manifestRef)).toString("utf8")),
    );
    const currentDiff = sha256(git(options.workspace, ["diff", "--binary", "HEAD"]));
    const head = git(options.workspace, ["rev-parse", "HEAD"]).toString("utf8").trim();
    const filesMatch =
      JSON.stringify(snapshotFiles(options.workspace)) === JSON.stringify(parsed.files);
    options.store.read(parsed.diff);
    if (filesMatch && head === parsed.gitHead && currentDiff === parsed.diff.sha256) {
      verified = parsed;
    }
  } catch {
    verified = undefined;
  }
  trace.checkpointVerified = verified !== undefined;

  moveStep({ type: "resource_available", candidateAvailable: true });
  // The domain gate refuses the start when the checkpoint context is not valid.
  if (
    !moveStep({
      type: "start",
      leaseHeld: true,
      executorEligible: true,
      contextSaved: verified !== undefined,
    }) ||
    verified === undefined
  ) {
    trace.final = "checkpoint-invalid";
    return trace;
  }

  // 9. Attempt 2 on the other profile, from the checkpoint.
  const secondResult = await runAttempt(
    "attempt-2",
    next,
    options.task.continuationPrompt(verified),
  );

  // A late "fail" from attempt 1 must be refused now that attempt 2 owns the step.
  const stale = transitionStep(step, { type: "fail", attempt: 1, currentAttempt: 2 });
  trace.staleAttemptRefused = !stale.ok && stale.reason === "STALE_ATTEMPT";

  const done = options.task.nextAction(options.workspace) === undefined;
  if (secondResult.outcome === "succeeded") {
    moveStep({
      type: "succeed",
      attempt: 2,
      currentAttempt: 2,
      resultValid: true,
      stepGatePassed: done,
    });
  } else {
    moveStep({ type: "fail", attempt: 2, currentAttempt: 2 });
  }
  trace.final = step === "succeeded" ? "succeeded-after-failover" : "continuation-failed";
  return trace;
}
