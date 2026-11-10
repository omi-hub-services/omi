// Fixed coordinates of this repository's GitHub Project and WSL checkout (ADR-0012, ADR-0014).
// Values come from docs/planning/github-project.md; option IDs are read live, never stored here.
// The WSL distro and checkout can be overridden for another machine with OMI_WSL_DISTRO and
// OMI_WSL_REPO_DIR.

export const OWNER = "omi-hub-services";
export const REPO = "omi";
export const REPO_SLUG = `${OWNER}/${REPO}`;
export const PROJECT_NUMBER = 1;
export const BASE_BRANCH = "develop";

/** Status options in board order (github-project.md, Field mapping). */
export const STATUS_ORDER = [
  "Backlog",
  "Ready",
  "In Progress",
  "In Review",
  "Waiting Approval",
  "Waiting Resource",
  "Blocked",
  "Done",
] as const;

export const PRIORITY_ORDER = ["P0", "P1", "P2"] as const;

/** Directory in WSL `$HOME` where worker stream-json logs are written (omi-next skill). */
export const RUNS_DIR_FROM_HOME = "omi-runs";

/** Hidden marker appended to the closing evidence comment so `close` never posts it twice. */
export const CLOSE_EVIDENCE_MARKER = "<!-- omi-coordinator:close-evidence -->";

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
