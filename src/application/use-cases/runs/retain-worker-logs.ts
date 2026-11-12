import type { WorkerLogStore } from "../../ports/worker-log-store.js";
import { planLogRetention } from "../../../domain/runs/log-retention-policy.js";
import type {
  LogDecision,
  LogRetentionSettings,
} from "../../../domain/runs/log-retention-policy.js";

export interface RetainWorkerLogsDeps {
  readonly logs: WorkerLogStore;
  readonly now: () => number;
}

export interface RetainWorkerLogsInput {
  /** Tasks recorded Done; only their logs are archived. */
  readonly doneTasks: readonly string[];
  readonly settings: LogRetentionSettings;
  /** Plan only; change nothing. */
  readonly dryRun?: boolean;
}

export interface RetainWorkerLogsResult {
  readonly dryRun: boolean;
  readonly decisions: readonly LogDecision[];
  readonly archived: number;
  readonly removed: number;
  readonly kept: number;
  /** Names whose archive or removal failed; the rest was still applied. */
  readonly failed: readonly string[];
}

/**
 * Keeps the worker log directory small (ADR-0014 rule 056, OMI-080): gzip and move the logs of
 * Done tasks into `archive/`, keep running workers' logs and the newest log of each profile, then
 * cap `archive/` by age and size. Safe to re-run; one failing file does not stop the others.
 */
export async function retainWorkerLogs(
  deps: RetainWorkerLogsDeps,
  input: RetainWorkerLogsInput,
): Promise<RetainWorkerLogsResult> {
  const listing = await deps.logs.list();
  const decisions = planLogRetention(
    { now: deps.now(), root: listing.root, archive: listing.archive },
    new Set(input.doneTasks),
    input.settings,
  );
  const dryRun = input.dryRun ?? false;
  const failed: string[] = [];
  for (const decision of decisions) {
    if (dryRun || decision.action === "keep") continue;
    try {
      if (decision.action === "archive") await deps.logs.archive(decision.name);
      else await deps.logs.remove(decision.name);
    } catch {
      failed.push(decision.name);
    }
  }
  // A dry run reports what would happen; a real run counts only what worked.
  const count = (action: LogDecision["action"]): number =>
    decisions.filter((d) => d.action === action && !failed.includes(d.name)).length;
  return {
    dryRun,
    decisions,
    archived: count("archive"),
    removed: count("delete"),
    kept: count("keep"),
    failed,
  };
}
