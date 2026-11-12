import type { ReworkCycle } from "../../domain/runs/rework-cycle.js";
import type { RunStatus } from "../../domain/runs/workflow-run.js";
import type { Hold, SkillCheck, WorkflowDiagram } from "../../domain/workflows/workflow-diagram.js";

/** One task the runtime is working on, as the `watch` page shows it. */
export interface TaskCard {
  readonly runId: string;
  readonly issueNumber: number;
  /** From the last successful GitHub board read; null before any successful read. */
  readonly planKey: string | null;
  readonly title: string | null;
  /** The template the run pinned; null when the catalog no longer has it. */
  readonly workflow: string | null;
  readonly runStatus: RunStatus;
  /** The step the task stands at; null when every step is done. */
  readonly step: string | null;
  readonly role: string | null;
  /** The worker running right now. */
  readonly who: {
    readonly executor: string;
    readonly profileId: string;
    readonly model: string;
    readonly effort: string | null;
    readonly startedAt: string;
  } | null;
  /** Skills and rules the step's worker really received; null when no worker was dispatched. */
  readonly loaded: { readonly skills: readonly string[]; readonly rules: readonly string[] } | null;
  readonly skillCheck: SkillCheck | null;
  readonly cycle: ReworkCycle & { readonly failures: number };
  readonly hold: Hold | null;
  readonly diagram: WorkflowDiagram;
  readonly notes: readonly string[];
}

export interface WatchSnapshot {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  /** Latest board refresh outcome; an unavailable refresh may retain last-good task data. */
  readonly board: "ok" | "unavailable" | "not-configured";
  readonly tasks: readonly TaskCard[];
}
