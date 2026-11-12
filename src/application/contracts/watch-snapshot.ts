import type { ReworkCycle } from "../../domain/runs/rework-cycle.js";
import type { RunStatus } from "../../domain/runs/workflow-run.js";
import type { DiagramLayout } from "../../domain/workflows/workflow-diagram-layout.js";
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
  /** The worker running right now; null when none runs. A value the source cannot tell is null. */
  readonly who: {
    readonly executor: string;
    readonly profileId: string;
    readonly model: string;
    readonly effort: string | null;
    readonly startedAt: string | null;
    /** The step this worker was dispatched for; null when the source cannot say. */
    readonly step: string | null;
    readonly role: string | null;
    /** At `generatedAt`; null when the source cannot say. */
    readonly elapsedSeconds: number | null;
  } | null;
  /**
   * Skills and rules the step's worker really received; null when no worker was dispatched.
   * `mandatoryRules` names the rules every worker gets; null when the source cannot tell.
   */
  readonly loaded: {
    readonly skills: readonly string[];
    readonly rules: readonly string[];
    readonly mandatoryRules: readonly string[] | null;
  } | null;
  readonly skillCheck: SkillCheck | null;
  readonly cycle: ReworkCycle & { readonly failures: number };
  readonly hold: Hold | null;
  readonly diagram: WorkflowDiagram;
  /** The drawn geometry of `diagram`, computed once by the domain so every source draws the same. */
  readonly layout: DiagramLayout;
  readonly notes: readonly string[];
}

export type { QuotaSeverity } from "../../domain/profiles/quota-policy.js";
import type { QuotaSeverity } from "../../domain/profiles/quota-policy.js";

/** What one subscription profile has left. A window that was not read is null, never 0. */
export interface QuotaRow {
  /** `unknown`: a verdict for a profile the registry does not list; shown, never dropped. */
  readonly tool: "claude" | "codex" | "unknown";
  readonly profile: string;
  /** Share (%) left of each window. */
  readonly fiveHourLeft: number | null;
  readonly sevenDayLeft: number | null;
  /** Local time the five-hour window resets (`HH:MM`); null when unknown or already past. */
  readonly resetText: string | null;
  readonly severity: QuotaSeverity;
  readonly freshness: "fresh" | "stale" | "unknown";
  /** Why there is no reading; redacted, never a token or response body. */
  readonly note: string | null;
}

export interface QuotaPanel {
  readonly state: "ok" | "loading" | "unavailable" | "not-configured";
  readonly reason: string | null;
  readonly rows: readonly QuotaRow[];
}

export interface WatchSnapshot {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  /**
   * Latest board refresh outcome; an unavailable refresh may retain last-good task data.
   * `loading`: the first read is still running, so an empty task list does not yet mean no tasks.
   */
  readonly board: "ok" | "unavailable" | "not-configured" | "loading";
  readonly tasks: readonly TaskCard[];
  readonly quota: QuotaPanel;
}
