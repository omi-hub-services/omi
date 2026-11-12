// Fixed coordinates of this repository's GitHub Project and WSL checkout (ADR-0012, ADR-0014).
// Values come from docs/planning/github-project.md; option IDs are read live, never stored here.
// The WSL distro and checkout can be overridden for another machine with OMI_WSL_DISTRO and
// OMI_WSL_REPO_DIR.
import type { Complexity } from "./effort-policy.ts";

export interface ModelEffort {
  readonly model: string;
  readonly effort: Complexity;
}

/** Explicit worker CLI models and Claude reviewer subagent aliases (OMI-058). */
export const EFFORT_POLICY = {
  claude: {
    low: { model: "claude-sonnet-5-5", effort: "low" },
    medium: { model: "claude-sonnet-5-5", effort: "medium" },
    high: { model: "claude-opus-5-5", effort: "high" },
  },
  codex: {
    low: { model: "gpt-6.1-sol", effort: "low" },
    medium: { model: "gpt-6.1-sol", effort: "medium" },
    high: { model: "gpt-6.1-sol", effort: "high" },
  },
  reviewer: {
    low: { model: "sonnet", effort: "low" },
    medium: { model: "sonnet", effort: "medium" },
    high: { model: "opus", effort: "high" },
  },
} as const satisfies Record<"claude" | "codex" | "reviewer", Record<Complexity, ModelEffort>>;

export const OWNER = "omi-hub-services";
export const REPO = "omi";
export const REPO_SLUG = `${OWNER}/${REPO}`;
export const PROJECT_NUMBER = 1;
export const BASE_BRANCH = "develop";

/**
 * GitHub login of the Coordinator account. Only `VERDICT` comments it posted count as agent
 * reviews for merge, close and status (OMI-052); the independent reviewer posts through it.
 */
export const COORDINATOR_LOGIN = "minibox-claude-code";

/** Status options in board order (github-project.md, Field mapping). */
import "../register-ts-imports.ts";
export const { STATUS_ORDER } = await import("../../src/domain/tasks/next-task-policy.ts");

export const PRIORITY_ORDER = ["P0", "P1", "P2"] as const;

/** Directory in WSL `$HOME` where worker stream-json logs are written (omi-next skill). */
export const RUNS_DIR_FROM_HOME = "omi-runs";

export interface RunsRetention {
  /** Files written within this many minutes are never moved or deleted (a worker may be live). */
  readonly recentMinutes: number;
  /** `archive/` is trimmed oldest first until it is at most this large... */
  readonly archiveMaxBytes: number;
  /** ...and drops files whose mtime is older than this many days. */
  readonly archiveMaxAgeDays: number;
}

/** Retention of worker logs in `~/omi-runs` (OMI-056). */
const { logRetentionSettings } = await import("../../src/application/contracts/log-retention.ts");
export const RUNS_RETENTION: RunsRetention = logRetentionSettings(undefined);

/** Hidden marker appended to the closing evidence comment so `close` never posts it twice. */
export const CLOSE_EVIDENCE_MARKER = "<!-- omi-coordinator:close-evidence -->";

/**
 * Worker subscription profiles (OMI-053). Claude uses `CLAUDE_CONFIG_DIR=~/.claude-profiles/<p>`,
 * Codex `CODEX_HOME=~/.codex-profiles/<p>`. `sharesCoordinatorAccount` marks a profile on the
 * same subscription as the Coordinator session, which pickProfile penalises.
 */
export const WORKER_PROFILES = [
  { tool: "claude", profile: "ggtintran", sharesCoordinatorAccount: false },
  { tool: "claude", profile: "minibox", sharesCoordinatorAccount: true },
  { tool: "codex", profile: "ggtintran", sharesCoordinatorAccount: false },
] as const satisfies readonly WorkerProfile[];

export interface WorkerProfile {
  readonly tool: "claude" | "codex";
  readonly profile: string;
  readonly sharesCoordinatorAccount: boolean;
}

export interface QuotaSettings {
  /** Refuse a profile with less than this share (%) of the 5-hour window left. */
  readonly minFiveHourLeftPercent: number;
  /** Refuse a profile with less than this share (%) of the 7-day window left. */
  readonly minSevenDayLeftPercent: number;
  /** Score points taken from a profile that shares the Coordinator's account. */
  readonly coordinatorSharedPenalty: number;
  /** Readings older than this rank below fresh ones (Claude logs; Codex is always live). */
  readonly staleAfterMinutes: number;
  /**
   * Claude profile assumed for old logs named `omi-NNN-<ts>.jsonl` (no profile in the name);
   * null ignores them.
   */
  readonly legacyLogProfile: string | null;
}

const { quotaPolicySchema } = await import("../../src/application/contracts/project-config.ts");
const quotaDefaults = quotaPolicySchema.parse({});
export const QUOTA_SETTINGS: QuotaSettings = {
  minFiveHourLeftPercent: quotaDefaults.min_five_hour_left_percent,
  minSevenDayLeftPercent: quotaDefaults.min_seven_day_left_percent,
  coordinatorSharedPenalty: quotaDefaults.coordinator_shared_penalty,
  staleAfterMinutes: quotaDefaults.stale_after_minutes,
  legacyLogProfile: null,
};

export interface WslTarget {
  /** true on Windows: steps go through wsl.exe; false inside Linux: run bash directly. */
  readonly viaWslExe: boolean;
  readonly distro: string;
  readonly repoDir: string;
}

export function wslTarget(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): WslTarget {
  return {
    viaWslExe: platform === "win32",
    distro: env.OMI_WSL_DISTRO ?? "Ubuntu-24.04",
    repoDir: env.OMI_WSL_REPO_DIR ?? "/home/ttin/github/omi",
  };
}

/** Shared minimum for usage endpoint calls and watch quota polls (OMI-068). */
export const QUOTA_MIN_INTERVAL_MS = 300_000;
