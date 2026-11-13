import { dispatchSkills } from "../../../domain/workflows/workflow-policy.js";
import {
  resolveWorkflowEffort,
  resolveQualityPolicy,
  workflowRisks,
} from "../../../domain/workflows/workflow-policy.js";
import { stepQualitySchema, workflowSchema } from "../../contracts/workflow.js";
import type { CheckRunner } from "../../ports/check-runner.js";
import type { CheckRunRecord } from "../../contracts/check-run.js";
import { workerPromptAssets } from "../../services/worker-prompt-assets.js";
import {
  renderQualityInstructions,
  renderWorkerPrompt,
} from "../../services/render-worker-prompt.js";
import { taskComplexitySchema, effortPolicySchema } from "../../contracts/task-complexity.js";
import { modelsConfigSchema } from "../../contracts/model-capability.js";
import { z, ZodError } from "zod";
import { transitionAgentAttempt } from "../../../domain/runs/agent-attempt.js";
import { taskReadinessReasons } from "../../../domain/tasks/readiness-gate.js";
import type { GithubTaskBoard } from "../../ports/github-task-board.js";
import { transitionStep } from "../../../domain/runs/step-run.js";
import { accessLevelSchema, MAX_EXECUTION_TIMEOUT_MS } from "../../contracts/agent-execution.js";
import { CredentialInputError } from "../../contracts/credential-input.js";
import type { ExecutionHandle } from "../../contracts/agent-execution.js";
import type { ArtifactReference } from "../../contracts/artifact.js";
import { contextPacketSchema } from "../../contracts/context.js";
import type { ContextPacket } from "../../contracts/context.js";
import { absolutePathSchema, identifierSchema, slugSchema } from "../../contracts/identifiers.js";
import {
  effortRank,
  effortSchema,
  modelNameSchema,
  executorSchema,
} from "../../contracts/model-capability.js";
import type { ResolutionCatalog } from "../../contracts/resolution-catalog.js";
import type { AgentExecutor } from "../../ports/agent-executor.js";
import { AgentExecutorError } from "../../ports/agent-executor.js";
import type { AttemptRecord, AttemptStore, StepRunReader } from "../../ports/attempt-store.js";
import { ArtifactError } from "../../ports/artifact-store.js";
import type { ArtifactStore } from "../../ports/artifact-store.js";
import type { BoundaryCheckpointHook } from "../../ports/checkpoint-hook.js";
import type { GitWorkspace } from "../../ports/git-workspace.js";
import type { Lease } from "../../ports/lease-store.js";
import type { RuleContent, RuleSource } from "../../ports/rule-source.js";
import type { SkillSource } from "../../ports/skill-source.js";
import type { StateUnitOfWork } from "../../ports/state-unit-of-work.js";
import { assembleContext, ContextSelectionError } from "../../services/assemble-context.js";
import { resolveRoleContext, RoleResolutionError } from "../../services/resolve-role-context.js";

/** Where an attempt's result artifacts must be published inside the artifact store. */
export function attemptArtifactRoot(attemptId: string): string {
  return `attempts/${attemptId}`;
}

const dispatchStepSchema = z.strictObject({
  checkEvidenceSteps: z.array(slugSchema).default([]),
  packetSteps: workflowSchema.shape.steps.optional(),
  quality: stepQualitySchema.optional(),
  models: modelsConfigSchema,
  selectedExecutor: executorSchema.optional(),
  task: taskComplexitySchema,
  effortPolicy: effortPolicySchema,
  stepRunId: identifierSchema,
  /** Attempt id already reserved by executor selection; absent means a fresh id is allocated. */
  reservedAttemptId: identifierSchema.optional(),
  taskId: identifierSchema,
  /** Worktree slug, see `TaskWorkspaceId`. */
  slug: slugSchema,
  /** Lease owner of the worktree writer for this attempt. */
  owner: identifierSchema,
  role: slugSchema,
  /** Extras the workflow step asks for on top of the role's own (see `resolveRoleContext`). */
  stepSkills: z.array(slugSchema).default([]),
  stepRules: z.array(slugSchema).default([]),
  excludedRules: z.array(slugSchema).default([]),
  /** Check ids the result must report before the step gate passes. */
  requiredChecks: z.array(slugSchema).default([]),
  execution: z.strictObject({
    profileHome: absolutePathSchema,
    model: modelNameSchema,
    effort: effortSchema,
    access: accessLevelSchema,
    timeoutMs: z.number().int().positive().max(MAX_EXECUTION_TIMEOUT_MS),
  }),
  /** The task-specific part of the packet; skills, rules and ids are filled in by dispatch. */
  context: contextPacketSchema.pick({
    taskSnapshot: true,
    acceptanceCriteria: true,
    businessBaselineHash: true,
    capabilityProfile: true,
    inputArtifacts: true,
    previousFindings: true,
    checkpointRef: true,
    expectedOutputSchema: true,
    allowedScope: true,
    approvalRefs: true,
  }),
});
export type DispatchStepInput = z.input<typeof dispatchStepSchema>;

export interface DispatchStepDependencies {
  readonly checks?: CheckRunner;
  /** Pinned, hash-verified catalog the resolver chooses from. */
  readonly catalog: ResolutionCatalog;
  /** Where the SKILL.md text of manifest skills comes from; verified against the manifest hash. */
  readonly skills: SkillSource;
  readonly rules: RuleSource;
  readonly steps: StepRunReader;
  readonly attempts: AttemptStore;
  readonly artifacts: ArtifactStore;
  readonly workspaces: GitWorkspace;
  /** Already selected by the caller (profile/executor selection is not this use case's job). */
  readonly executor: AgentExecutor;
  readonly unitOfWork: StateUnitOfWork;
  readonly leaseTtlMs: number;
  /** Business checkpoint at the dispatch boundary (OMI-026); absent means none is taken. */
  readonly checkpoint?: BoundaryCheckpointHook;
  /** Live Project reader for the readiness gate before a task branch is created (OMI-079). */
  readonly board?: Pick<GithubTaskBoard, "read">;
  readonly now: () => number;
  readonly nextId: () => string;
}

export type DispatchRefusal =
  | "INVALID_INPUT"
  | "STEP_NOT_FOUND"
  | "STEP_NOT_READY"
  /** A role, skill or rule id the catalog does not contain. */
  | "UNKNOWN_REFERENCE"
  /** The request tried to drop a mandatory gate (rule). */
  | "MANDATORY_GATE_MISSING"
  | "AMBIGUOUS_CATALOG"
  | "NO_ELIGIBLE_EXECUTOR"
  | "INPUT_ARTIFACT_INVALID"
  /** A manifest skill has no readable content, so it cannot be inlined. */
  | "SKILL_MISSING"
  /** A manifest skill's content hash differs from the pinned one. */
  | "SKILL_HASH_MISMATCH"
  | "RULE_MISSING"
  | "RULE_HASH_MISMATCH"
  | "WORKSPACE_UNAVAILABLE"
  /** The Issue lacks a Plan Key, a Project field or an acceptance criterion; no branch was made. */
  | "TASK_NOT_READY"
  | "CONTEXT_REJECTED"
  /** The before-dispatch checkpoint could not be written; nothing was dispatched. */
  | "CHECKPOINT_FAILED"
  /** The state change was refused (stale version, lease fence, missing row). */
  | "STATE_REJECTED"
  | "EXECUTOR_START_FAILED";

export type DispatchStepResult =
  | {
      readonly ok: true;
      readonly attempt: AttemptRecord;
      readonly handle: ExecutionHandle;
      readonly contextPacket: ContextPacket;
    }
  | { readonly ok: false; readonly reason: DispatchRefusal; readonly detail?: string };

const RESOLUTION_REFUSALS = {
  UNKNOWN_REFERENCE: "UNKNOWN_REFERENCE",
  MANDATORY_RULE_DROPPED: "MANDATORY_GATE_MISSING",
  AMBIGUOUS_CATALOG: "AMBIGUOUS_CATALOG",
} as const satisfies Record<RoleResolutionError["code"], DispatchRefusal>;

const iso = (ms: number): string => new Date(ms).toISOString();

interface InlinedSkill {
  readonly id: string;
  readonly version: string;
  readonly skillMd: string;
  readonly bundledFiles: readonly string[];
}

/** Skills and rules share the same fail-closed manifest hash verification before allocation. */
function readManifest<T extends { readonly sha256: string }>(
  source: { read(id: string, version: string): T | undefined },
  manifest: ContextPacket["skillsManifest"],
  kind: "SKILL" | "RULE",
):
  | { readonly ok: true; readonly contents: readonly (T & { id: string; version: string })[] }
  | { readonly ok: false; readonly reason: DispatchRefusal; readonly detail: string } {
  const contents: (T & { id: string; version: string })[] = [];
  for (const entry of manifest) {
    const content = source.read(entry.id, entry.version);
    if (content === undefined) return { ok: false, reason: `${kind}_MISSING`, detail: entry.id };
    if (content.sha256 !== entry.sha256) {
      return { ok: false, reason: `${kind}_HASH_MISMATCH`, detail: entry.id };
    }
    contents.push({ ...content, id: entry.id, version: entry.version });
  }
  return { ok: true, contents };
}

function skillSection(skill: InlinedSkill): string {
  return [
    `=== Skill ${skill.id} (version ${skill.version}) ===`,
    skill.skillMd.trimEnd(),
    ...(skill.bundledFiles.length === 0
      ? []
      : [`Bundled files of skill ${skill.id} (read them from the workspace when needed):`]),
    ...skill.bundledFiles.map((path) => `- ${path}`),
    `=== End of skill ${skill.id} ===`,
  ].join("\n");
}

function buildPrompt(
  packet: ContextPacket,
  packetRef: ArtifactReference,
  root: string,
  skills: readonly InlinedSkill[],
  rules: readonly (RuleContent & { id: string; version: string })[],
  checkLogs: readonly string[],
): string {
  return renderWorkerPrompt(workerPromptAssets.skeleton, {
    identity: `You are the "${packet.role}" worker for step "${packet.stepId}" (attempt ${packet.attemptId}).`,
    workspace: "",
    read_first: "",
    notes: [
      ...(packet.quality === undefined ? [] : [renderQualityInstructions(packet.quality)]),
      ...checkLogs,
    ].join("\n"),
    task_context: [
      `Acceptance criteria (${String(packet.acceptanceCriteria.length)} top-level criteria):`,
      ...packet.acceptanceCriteria.map(
        (criterion, index) => `AC-${String(index + 1)}: ${JSON.stringify(criterion)}`,
      ),
      `Context packet ${packetRef.path} (sha256 ${packetRef.sha256}):`,
      JSON.stringify(packet, null, 2),
    ].join("\n"),
    restrictions: [
      workerPromptAssets.restrictions,
      packet.quality?.step === "verify" || packet.quality?.step === "review"
        ? workerPromptAssets.qualityChecks
        : workerPromptAssets.developerChecks,
    ].join("\n"),
    report_contract: workerPromptAssets.report
      .replace("{{artifact_root}}", root)
      .replace("{{expected_schema}}", packet.expectedOutputSchema)
      .replace("{{attempt_id}}", packet.attemptId)
      .replace(
        "{{report_format}}",
        JSON.stringify({
          schemaVersion: 1,
          runId: packet.runId,
          stepId: packet.stepId,
          attemptId: packet.attemptId,
          status: "succeeded|failed|blocked",
          summary: "branch, files per layer, check results, unverified items and open decisions",
          artifacts: [],
          revision: { headSha: "<40 hex>", baseSha: "<40 hex>" },
          checks: [{ id: "<check id>", evidenceRef: "<artifact path>" }],
          skillsApplied: [{ id: "<assigned skill>", evidenceRef: "<artifact path>" }],
          findings: [],
        }),
      ),
    skills: [workerPromptAssets.skillInstructions, ...skills.map(skillSection)].join("\n"),
    rules: rules
      .map((rule) =>
        [
          `=== Rule ${rule.id} (version ${rule.version}) ===`,
          rule.ruleMd,
          `=== End of rule ${rule.id} ===`,
        ].join("\n"),
      )
      .join("\n"),
  });
}

/**
 * Allocates an attempt, its context packet and its worktree through ports, moves the step to
 * running, and hands the packet to the injected executor. The packet carries exactly the
 * skills/rules `resolveRoleContext` picks for the step's role (with version and hash); the same
 * set is recorded on the attempt. Refusals return a reason; nothing is left half-allocated
 * (the writer lease is released and the attempt is cancelled or failed).
 */
export async function dispatchStep(
  deps: DispatchStepDependencies,
  input: unknown,
): Promise<DispatchStepResult> {
  const parsed = dispatchStepSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const command = parsed.data;
  if (command.selectedExecutor !== undefined && command.selectedExecutor !== deps.executor.executor)
    return { ok: false, reason: "NO_ELIGIBLE_EXECUTOR" };

  const step = deps.steps.get(command.stepRunId);
  if (step === undefined) return { ok: false, reason: "STEP_NOT_FOUND" };
  if (step.status !== "ready") return { ok: false, reason: "STEP_NOT_READY" };
  const capability = command.models.capability_profiles[command.context.capabilityProfile.id];
  const contextFloor = command.context.capabilityProfile.min_effort;
  const modelFloor = capability?.min_effort ?? contextFloor;
  const decision = resolveWorkflowEffort(
    { ...command.task, acCount: command.context.acceptanceCriteria.length },
    command.effortPolicy,
    effortRank(modelFloor) > effortRank(contextFloor) ? modelFloor : contextFloor,
    command.quality,
  );
  if (
    command.quality !== undefined &&
    command.quality.steps.length > 1 &&
    !resolveQualityPolicy({
      qualityPolicy: command.quality.policy,
      complexity: decision.complexity,
      step: command.quality.step,
      round: command.quality.round,
      risks: { security: false, gates: false, data: false },
    }).combineVerifyReview
  )
    return { ok: false, reason: "CONTEXT_REJECTED", detail: "RISK_REQUIRES_SEPARATE_WORKERS" };
  const verified = command.models.verified_models[command.context.capabilityProfile.id] ?? [];
  const modelSupported = Object.entries(command.models.models).some(
    ([alias, model]) =>
      verified.includes(alias) &&
      model.executor === deps.executor.executor &&
      model.model === command.execution.model &&
      model.supported_efforts.includes(command.execution.effort),
  );
  // Fail before allocating anything when the chosen executor settings cannot meet the step.
  if (
    !modelSupported ||
    capability === undefined ||
    (capability.required_executor !== undefined &&
      capability.required_executor !== deps.executor.executor) ||
    (command.context.capabilityProfile.required_executor !== undefined &&
      command.context.capabilityProfile.required_executor !== deps.executor.executor) ||
    effortRank(command.execution.effort) < effortRank(capability.min_effort) ||
    effortRank(command.execution.effort) < effortRank(decision.minEffort)
  ) {
    return { ok: false, reason: "NO_ELIGIBLE_EXECUTOR" };
  }

  // Nothing is allocated yet: a task that fails the gate gets no attempt, branch or worker.
  if (deps.board !== undefined) {
    const issueNumber = command.context.taskSnapshot.issueNumber;
    const task = await deps.board.read(issueNumber);
    const reasons =
      task === undefined
        ? [`#${String(issueNumber)} is not on the Project`]
        : taskReadinessReasons(task);
    if (reasons.length > 0)
      return { ok: false, reason: "TASK_NOT_READY", detail: reasons.join("; ") };
  }

  let resolved;
  try {
    resolved = resolveRoleContext(deps.catalog, {
      role: command.role,
      // Common boundary for ordinary and specialist dispatch: an implement rework round resumes with receiving-code-review.
      stepSkills: [
        ...(command.quality === undefined
          ? command.stepSkills
          : dispatchSkills(command.quality.step, command.stepSkills, command.quality.round)),
      ],
      stepRules: command.stepRules,
      excludedRules: command.excludedRules,
    });
  } catch (error) {
    if (error instanceof RoleResolutionError) {
      return { ok: false, reason: RESOLUTION_REFUSALS[error.code], detail: error.message };
    }
    throw error;
  }

  const inlined = readManifest(deps.skills, resolved.skills, "SKILL");
  if (!inlined.ok) return { ok: false, reason: inlined.reason, detail: inlined.detail };
  const rules = readManifest(deps.rules, resolved.rules, "RULE");
  if (!rules.ok) return { ok: false, reason: rules.reason, detail: rules.detail };

  try {
    deps.artifacts.manifest(command.context.inputArtifacts);
  } catch (error) {
    if (error instanceof ArtifactError) {
      return { ok: false, reason: "INPUT_ARTIFACT_INVALID", detail: error.code };
    }
    throw error;
  }

  const startedMs = deps.now();
  const leaseRequest = {
    taskId: command.taskId,
    slug: command.slug,
    owner: command.owner,
    now: iso(startedMs),
    expiresAt: iso(startedMs + deps.leaseTtlMs),
  };
  const created = deps.workspaces.createTask(leaseRequest);
  if (!created.ok)
    return { ok: false, reason: "WORKSPACE_UNAVAILABLE", detail: created.error.code };
  const acquired = deps.workspaces.acquireWriter(leaseRequest);
  if (!acquired.ok) {
    return { ok: false, reason: "WORKSPACE_UNAVAILABLE", detail: acquired.error.code };
  }
  const lease: Lease = acquired.value;
  const release = (): void => {
    deps.workspaces.releaseWriter({
      taskId: command.taskId,
      slug: command.slug,
      owner: command.owner,
      generation: lease.generation,
      now: iso(deps.now()),
    });
  };

  try {
    if (
      command.quality !== undefined &&
      command.quality.steps.length > 1 &&
      deps.workspaces.changedPaths !== undefined
    ) {
      const changed = deps.workspaces.changedPaths(created.value.path);
      if (
        !changed.ok ||
        !resolveQualityPolicy({
          qualityPolicy: command.quality.policy,
          complexity: decision.complexity,
          step: command.quality.step,
          round: command.quality.round,
          risks: workflowRisks(changed.value),
        }).combineVerifyReview
      ) {
        release();
        return { ok: false, reason: "CONTEXT_REJECTED", detail: "RISK_REQUIRES_SEPARATE_WORKERS" };
      }
    }
    // The worktree exists and no writer runs yet, so this is the stable point to snapshot before
    // any attempt, packet or state change exists. A failed checkpoint refuses the dispatch.
    const checkpoint = deps.checkpoint?.({
      kind: "before-dispatch",
      runId: step.runId,
      stepRunId: step.id,
      stepId: step.stepId,
      workspacePath: created.value.path,
      outputs: [],
    });
    if (checkpoint !== undefined && !checkpoint.ok) {
      release();
      return { ok: false, reason: "CHECKPOINT_FAILED", detail: checkpoint.reason };
    }

    const attemptId = command.reservedAttemptId ?? deps.nextId();
    const previous = deps.attempts.latestForStep(step.id);
    const attemptNumber =
      deps.attempts.reservedNumber?.(attemptId) ?? (previous?.attemptNumber ?? 0) + 1;

    const artifactRoot = attemptArtifactRoot(attemptId);
    let reviewDelta: ContextPacket["reviewDelta"];
    const qualityWorker = command.quality?.step === "verify" || command.quality?.step === "review";
    if (qualityWorker && (command.quality?.round ?? 1) > 1) {
      const previousVerdict = deps.attempts.qualityHistory?.(step.id).previousVerdict;
      const previousHead = previousVerdict?.revision?.headSha;
      const delta =
        previousHead === undefined
          ? undefined
          : deps.workspaces.diffSince?.(created.value.path, previousHead);
      if (previousVerdict === undefined || delta?.ok !== true || delta.value.length > 100_000) {
        release();
        return {
          ok: false,
          reason: "CONTEXT_REJECTED",
          detail: "PREVIOUS_VERDICT_OR_DELTA_MISSING",
        };
      }
      reviewDelta = { previousVerdict, diff: delta.value };
    }
    const checkEvidence: CheckRunRecord[] = [];
    const qaInputs: ArtifactReference[] = [];
    if (command.checkEvidenceSteps.length > 0) {
      try {
        const current = deps.workspaces.inspect(created.value.path);
        if (!current.ok) throw new Error("QA_CHECK_EVIDENCE_INVALID");
        for (const sourceStep of command.checkEvidenceSteps) {
          const qa = deps.attempts.latestForRunStep?.(step.runId, sourceStep);
          if (
            qa?.status !== "succeeded" ||
            qa.runId !== step.runId ||
            qa.stepId !== sourceStep ||
            deps.steps.get(qa.stepRunId)?.status !== "succeeded" ||
            qa.workspace.path !== created.value.path
          )
            throw new Error("QA_CHECK_EVIDENCE_INVALID");
          const packet = contextPacketSchema.parse(
            JSON.parse(new TextDecoder().decode(deps.artifacts.read(qa.contextPacket))) as unknown,
          );
          const checks = packet.checkEvidence ?? [];
          if (
            packet.runId !== step.runId ||
            packet.stepId !== sourceStep ||
            packet.attemptId !== qa.id ||
            packet.businessBaselineHash !== command.context.businessBaselineHash ||
            !qa.requiredChecks
              .filter((id) => deps.checks?.has(id))
              .every((id) => checks.some((check) => check.checkId === id))
          )
            throw new Error("QA_CHECK_EVIDENCE_INVALID");
          for (const check of checks) {
            if (
              check.status !== "passed" ||
              check.exitCode !== 0 ||
              check.revision !== current.value.headSha ||
              !check.evidence.path.startsWith(`${qa.artifactRoot}/`)
            )
              throw new Error("QA_CHECK_EVIDENCE_INVALID");
            const bytes = deps.artifacts.read(check.evidence);
            if (bytes.length === 0) throw new Error("QA_CHECK_EVIDENCE_INVALID");
            qaInputs.push(check.evidence);
            // Retain the original hash while meeting the existing attempt-local evidence gate.
            const evidence = deps.artifacts.write({
              id: `${attemptId}-qa-${qa.id}-${check.checkId}`,
              path: `${artifactRoot}/checks/qa-${qa.id}-${check.checkId}.json`,
              bytes: new Uint8Array(bytes),
              classification: "check-evidence",
              createdAt: iso(deps.now()),
            });
            checkEvidence.push({ ...check, evidence });
          }
        }
      } catch {
        release();
        return { ok: false, reason: "CONTEXT_REJECTED", detail: "QA_CHECK_EVIDENCE_INVALID" };
      }
    }
    if (qualityWorker) {
      for (const checkId of command.requiredChecks) {
        if (!checkEvidence.some((check) => check.checkId === checkId) && deps.checks?.has(checkId))
          checkEvidence.push(
            await deps.checks.run({
              attemptId,
              checkId,
              workspacePath: created.value.path,
              artifactRoot,
            }),
          );
      }
    }
    const checkLogs = checkEvidence.map(
      (check) =>
        `Script check ${check.checkId} on ${check.revision} (${check.status}):\n${new TextDecoder().decode(deps.artifacts.read(check.evidence))}`,
    );

    const { inputArtifacts, ...taskContext } = command.context;
    let packet: ContextPacket;
    try {
      const reference = <T>(entries: readonly T[]) =>
        entries.map((entry) => ({ roles: [command.role], steps: [step.stepId], reference: entry }));
      packet = assembleContext({
        context: {
          ...(command.quality === undefined ? {} : { quality: command.quality }),
          ...(command.packetSteps === undefined
            ? {}
            : {
                stepAssignments: command.packetSteps.map(({ id, role, skills, rules }) => ({
                  id,
                  role,
                  skills,
                  rules,
                })),
              }),
          ...(checkEvidence.length === 0 ? {} : { checkEvidence }),
          ...(reviewDelta === undefined ? {} : { reviewDelta }),
          schemaVersion: 1,
          runId: step.runId,
          stepId: step.stepId,
          attemptId,
          ...taskContext,
          role: command.role,
          workspace: { path: created.value.path },
        },
        skills: reference(resolved.skills),
        rules: reference(resolved.rules),
        inputs: reference([...inputArtifacts, ...qaInputs]),
      });
    } catch (error) {
      if (
        error instanceof ZodError ||
        error instanceof ContextSelectionError ||
        error instanceof CredentialInputError
      ) {
        release();
        return { ok: false, reason: "CONTEXT_REJECTED", detail: error.name };
      }
      throw error;
    }

    const contextPacket = deps.artifacts.write({
      id: `${attemptId}-context`,
      path: `${artifactRoot}/context-packet.json`,
      bytes: new TextEncoder().encode(JSON.stringify(packet)),
      classification: "context-packet",
      createdAt: iso(deps.now()),
    });

    const record: AttemptRecord = {
      id: attemptId,
      runId: step.runId,
      stepRunId: step.id,
      stepId: step.stepId,
      attemptNumber,
      status: "pending",
      executor: deps.executor.executor,
      selection: {
        model: command.execution.model,
        effort: command.execution.effort,
        reason: decision.reason,
      },
      access: command.execution.access,
      role: resolved.role,
      skills: packet.skillsManifest,
      rules: packet.rulesManifest,
      contextPacket,
      artifactRoot,
      requiredChecks: [
        ...new Set([...command.requiredChecks, ...checkEvidence.map((check) => check.checkId)]),
      ],
      workspace: {
        taskId: command.taskId,
        slug: command.slug,
        path: created.value.path,
        branch: created.value.branch,
        owner: command.owner,
        leaseKey: lease.resourceKey,
        generation: lease.generation,
      },
      startedAt: iso(startedMs),
    };
    deps.attempts.create(record);

    const stepStart = transitionStep(step.status, {
      type: "start",
      leaseHeld: true,
      executorEligible: true,
      contextSaved: true,
    });
    const attemptStart = transitionAgentAttempt("pending", { type: "start", leaseHeld: true });
    if (!stepStart.ok || !attemptStart.ok) {
      deps.attempts.setStatus(attemptId, "cancelled");
      release();
      return { ok: false, reason: "STEP_NOT_READY" };
    }
    const committed = deps.unitOfWork.commit({
      target: {
        kind: "step_run",
        id: step.id,
        expectedVersion: step.version,
        toStatus: stepStart.to,
      },
      at: iso(deps.now()),
      event: {
        eventId: deps.nextId(),
        kind: "step.dispatched",
        subject: step.id,
        runId: step.runId,
        correlationId: attemptId,
        payload: JSON.stringify({
          attemptId,
          attemptNumber,
          selection: record.selection,
          role: resolved.role,
          skills: record.skills,
          rules: record.rules,
          contextPacket,
        }),
      },
      fence: { resourceKey: lease.resourceKey, owner: command.owner, generation: lease.generation },
    });
    if (!committed.ok) {
      deps.attempts.setStatus(attemptId, "cancelled");
      release();
      return { ok: false, reason: "STATE_REJECTED", detail: committed.reason };
    }
    deps.attempts.setStatus(attemptId, attemptStart.to);

    try {
      const handle = await deps.executor.start({
        attemptId,
        workspace: created.value.path,
        profileHome: command.execution.profileHome,
        prompt: buildPrompt(
          packet,
          contextPacket,
          artifactRoot,
          inlined.contents,
          rules.contents,
          checkLogs,
        ),
        model: command.execution.model,
        effort: command.execution.effort,
        access: command.execution.access,
        timeoutMs: command.execution.timeoutMs,
      });
      return {
        ok: true,
        attempt: { ...record, status: attemptStart.to },
        handle,
        contextPacket: packet,
      };
    } catch (error) {
      if (!(error instanceof AgentExecutorError)) throw error;
      // The step is already running: fail the attempt so the step does not hang.
      deps.attempts.setStatus(attemptId, "failed");
      deps.unitOfWork.commit({
        target: {
          kind: "step_run",
          id: step.id,
          expectedVersion: committed.newVersion,
          toStatus: "failed",
        },
        at: iso(deps.now()),
        event: {
          eventId: deps.nextId(),
          kind: "step.failed",
          subject: step.id,
          runId: step.runId,
          correlationId: attemptId,
          payload: JSON.stringify({ attemptId, reason: error.code }),
        },
        fence: {
          resourceKey: lease.resourceKey,
          owner: command.owner,
          generation: lease.generation,
        },
      });
      release();
      return { ok: false, reason: "EXECUTOR_START_FAILED", detail: error.code };
    }
  } catch (error) {
    release();
    throw error;
  }
}
