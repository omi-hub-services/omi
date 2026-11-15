import { ZodError, z } from "zod";
import { checkpointKindSchema } from "../../contracts/checkpoint.js";
import type { CheckpointManifest } from "../../contracts/checkpoint.js";
import { artifactReferenceSchema } from "../../contracts/artifact.js";
import { CredentialInputError } from "../../contracts/credential-input.js";
import type { CredentialPolicy } from "../../contracts/credential-input.js";
import {
  absolutePathSchema,
  identifierSchema,
  sha256Schema,
  slugSchema,
} from "../../contracts/identifiers.js";
import { checkpointManifestSchema } from "../../contracts/checkpoint.js";
import type { AttemptStore } from "../../ports/attempt-store.js";
import { ArtifactError } from "../../ports/artifact-store.js";
import type { ArtifactStore } from "../../ports/artifact-store.js";
import { CheckpointError } from "../../ports/checkpoint-store.js";
import type { CheckpointRecord, CheckpointStore } from "../../ports/checkpoint-store.js";
import type { ContentHasher } from "../../ports/content-hasher.js";
import type { GitWorkspace } from "../../ports/git-workspace.js";
import { buildCheckpointManifest } from "../../services/build-checkpoint-manifest.js";

/** Everything in a manifest that the runtime cannot read back from its own ports. */
const writeCheckpointSchema = z.strictObject({
  runId: identifierSchema,
  stepRunId: identifierSchema.optional(),
  /** When given, the attempt supplies step id, attempt number, skills and rules. */
  attemptId: identifierSchema.optional(),
  kind: checkpointKindSchema,
  /** Task worktree. Its writer must be stopped (or not started) when the checkpoint is taken. */
  workspacePath: absolutePathSchema,
  stepId: slugSchema.optional(),
  hashes: z.strictObject({
    config: sha256Schema,
    template: sha256Schema,
    skills: checkpointManifestSchema.shape.hashes.shape.skills.default([]),
    rules: checkpointManifestSchema.shape.hashes.shape.rules.default([]),
  }),
  taskSnapshot: checkpointManifestSchema.shape.taskSnapshot,
  acceptanceCriteria: checkpointManifestSchema.shape.acceptanceCriteria,
  businessBaselineHash: sha256Schema,
  counters: checkpointManifestSchema.shape.counters,
  decisions: checkpointManifestSchema.shape.decisions.default([]),
  approvalRefs: checkpointManifestSchema.shape.approvalRefs.default([]),
  /** Output artifacts; the runtime re-reads and verifies each hash and adds the size. */
  outputs: z.array(artifactReferenceSchema).default([]),
  previousFindings: checkpointManifestSchema.shape.previousFindings.default([]),
  nextAction: checkpointManifestSchema.shape.nextAction,
});
export type WriteCheckpointInput = z.input<typeof writeCheckpointSchema>;

export interface WriteCheckpointDependencies {
  readonly checkpoints: CheckpointStore;
  readonly attempts: AttemptStore;
  readonly artifacts: ArtifactStore;
  readonly workspaces: GitWorkspace;
  readonly hasher: ContentHasher;
  /** Boundary-supplied known secret values and credential roots (ADR-0022). */
  readonly credentialPolicy?: CredentialPolicy;
  readonly now: () => number;
  readonly nextId: () => string;
}

/** Nothing was recorded: no row and no file exist for the refused checkpoint. */
export type WriteCheckpointRefusal =
  | "INVALID_INPUT"
  | "ATTEMPT_NOT_FOUND"
  | "ATTEMPT_MISMATCH"
  | "OUTPUT_INVALID"
  | "WORKSPACE_UNAVAILABLE"
  /** The manifest holds credential material or a credential file reference. */
  | "CREDENTIAL_REJECTED"
  | "MANIFEST_INVALID"
  /** The store refused or could not complete the save; see `detail`. */
  | "WRITE_FAILED";

export type WriteCheckpointResult =
  | { readonly ok: true; readonly checkpoint: CheckpointRecord }
  | { readonly ok: false; readonly reason: WriteCheckpointRefusal; readonly detail?: string };

/**
 * Builds the tool-independent business checkpoint for a step boundary (architecture §10) and saves
 * it atomically: the manifest file is durable before its row says `valid`. Git state, the
 * uncommitted-file manifest and output sizes are read through ports at call time; the caller adds
 * the business progress. A manifest that would carry a credential is refused, never redacted.
 */
export function writeCheckpoint(
  deps: WriteCheckpointDependencies,
  input: unknown,
): WriteCheckpointResult {
  const parsed = writeCheckpointSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_INPUT" };
  const command = parsed.data;

  let stepRunId = command.stepRunId;
  let stepId = command.stepId;
  let attemptNumber: number | undefined;
  let skills = command.hashes.skills;
  let rules = command.hashes.rules;
  if (command.attemptId !== undefined) {
    const attempt = deps.attempts.get(command.attemptId);
    if (attempt === undefined) return { ok: false, reason: "ATTEMPT_NOT_FOUND" };
    if (
      attempt.runId !== command.runId ||
      (stepRunId !== undefined && stepRunId !== attempt.stepRunId)
    ) {
      return { ok: false, reason: "ATTEMPT_MISMATCH" };
    }
    stepRunId = attempt.stepRunId;
    stepId = attempt.stepId;
    attemptNumber = attempt.attemptNumber;
    skills = attempt.skills;
    rules = attempt.rules;
  }

  let outputs;
  try {
    outputs = deps.artifacts.manifest(command.outputs).artifacts;
  } catch (error) {
    if (error instanceof ArtifactError) {
      return { ok: false, reason: "OUTPUT_INVALID", detail: error.code };
    }
    throw error;
  }

  const state = deps.workspaces.inspect(command.workspacePath);
  if (!state.ok) return { ok: false, reason: "WORKSPACE_UNAVAILABLE", detail: state.error.code };
  const uncommitted = deps.workspaces.listUncommitted(command.workspacePath);
  if (!uncommitted.ok) {
    return { ok: false, reason: "WORKSPACE_UNAVAILABLE", detail: uncommitted.error.code };
  }

  const createdAt = new Date(deps.now()).toISOString();
  const checkpointId = deps.nextId();
  const candidate: CheckpointManifest = {
    schemaVersion: 1,
    checkpointId,
    kind: command.kind,
    createdAt,
    runId: command.runId,
    ...(stepRunId === undefined ? {} : { stepRunId }),
    ...(stepId === undefined ? {} : { stepId }),
    ...(command.attemptId === undefined ? {} : { attemptId: command.attemptId }),
    ...(attemptNumber === undefined ? {} : { attemptNumber }),
    hashes: { config: command.hashes.config, template: command.hashes.template, skills, rules },
    taskSnapshot: command.taskSnapshot,
    acceptanceCriteria: command.acceptanceCriteria,
    businessBaselineHash: command.businessBaselineHash,
    counters: command.counters,
    decisions: command.decisions,
    approvalRefs: command.approvalRefs,
    outputs: [...outputs],
    git: {
      worktreePath: state.value.path,
      headSha: state.value.headSha,
      branch: state.value.branch,
      dirty: state.value.dirty,
    },
    uncommitted: uncommitted.value,
    previousFindings: command.previousFindings,
    nextAction: command.nextAction,
  };

  let built;
  try {
    built = buildCheckpointManifest(deps.hasher, candidate, deps.credentialPolicy);
  } catch (error) {
    if (error instanceof CredentialInputError) return { ok: false, reason: "CREDENTIAL_REJECTED" };
    if (error instanceof ZodError) return { ok: false, reason: "MANIFEST_INVALID" };
    throw error;
  }

  try {
    const checkpoint = deps.checkpoints.save({
      id: checkpointId,
      runId: command.runId,
      ...(stepRunId === undefined ? {} : { stepRunId }),
      kind: command.kind,
      bytes: built.bytes,
      gitRevision: state.value.headSha,
      createdAt,
    });
    return { ok: true, checkpoint };
  } catch (error) {
    if (error instanceof CheckpointError) {
      return { ok: false, reason: "WRITE_FAILED", detail: error.code };
    }
    if (error instanceof CredentialInputError) return { ok: false, reason: "CREDENTIAL_REJECTED" };
    throw error;
  }
}
