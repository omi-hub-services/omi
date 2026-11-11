import type { ArtifactReference } from "../contracts/artifact.js";
import type { AccessLevel } from "../contracts/agent-execution.js";
import type { ContextPacket } from "../contracts/context.js";
import type { Effort, Executor } from "../contracts/model-capability.js";
import type { AgentAttemptStatus } from "../../domain/runs/agent-attempt.js";
import type { StepStatus } from "../../domain/runs/step-run.js";

/** The step run row as dispatch and result recording see it. `version` guards state changes. */
export interface StepRunRecord {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly status: StepStatus;
  readonly version: number;
}

export interface StepRunReader {
  get(stepRunId: string): StepRunRecord | undefined;
}

/** What one attempt was given and where its output must land. Written once at dispatch. */
export interface AttemptRecord {
  readonly id: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly stepId: string;
  /** 1-based and increasing per step run; a retry is a new attempt, never a reuse. */
  readonly attemptNumber: number;
  readonly status: AgentAttemptStatus;
  readonly executor: Executor;
  readonly selection?: {
    readonly model: string;
    readonly effort: Effort;
    readonly reason: string;
  };
  readonly access: AccessLevel;
  readonly role: { readonly id: string; readonly version: number; readonly sha256: string };
  /** Exactly the skills/rules the worker received, with version and hash. */
  readonly skills: ContextPacket["skillsManifest"];
  readonly rules: ContextPacket["rulesManifest"];
  readonly contextPacket: ArtifactReference;
  /** Result artifacts and evidence must live under this relative prefix of the artifact store. */
  readonly artifactRoot: string;
  /** Check ids the step gate needs the result to report. */
  readonly requiredChecks: readonly string[];
  readonly workspace: {
    readonly taskId: string;
    readonly slug: string;
    readonly path: string;
    readonly branch: string;
    readonly owner: string;
    readonly leaseKey: string;
    readonly generation: number;
  };
  readonly startedAt: string;
}

/** Runtime-owned attempt rows. Implemented over SQLite `agent_attempts` by infrastructure. */
export interface AttemptStore {
  create(record: AttemptRecord): void;
  get(attemptId: string): AttemptRecord | undefined;
  /** The attempt with the highest `attemptNumber` of the step run. */
  latestForStep(stepRunId: string): AttemptRecord | undefined;
  setStatus(attemptId: string, status: AgentAttemptStatus): void;
}
