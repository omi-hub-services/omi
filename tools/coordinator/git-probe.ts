// Branch state of a checkout, read with one bash payload (key=value lines) and parsed purely.
import { BASE_BRANCH } from "./coordinator-settings.ts";
import type { CleanupState } from "./flow-plans.ts";
import { shellQuote } from "./process-runner.ts";

export interface ProbeOptions {
  /** `git fetch --prune origin` first, so "merged" is judged against the real origin/develop. */
  readonly fetch?: boolean;
  /** Also read the branch SHA on origin (network). */
  readonly remote?: boolean;
}

export interface ProbedState extends CleanupState {
  readonly head: string;
  /** No tracked or untracked (non-ignored) changes. */
  readonly clean: boolean;
  readonly remote: string | null;
}

export function branchProbe(branch: string, options: ProbeOptions = {}): string {
  const ref = shellQuote(`refs/heads/${branch}`);
  return [
    ...(options.fetch ? ["git fetch --prune --quiet origin"] : []),
    "echo current=$(git rev-parse --abbrev-ref HEAD)",
    `echo local=$(git rev-parse --verify --quiet ${ref})`,
    "echo dirty=$(git status --porcelain --untracked-files=no | head -c 1)",
    "echo changes=$(git status --porcelain | head -c 1)",
    "echo head=$(git rev-parse HEAD)",
    `echo merged=$(git merge-base --is-ancestor ${ref} origin/${BASE_BRANCH} 2>/dev/null && echo yes || echo no)`,
    ...(options.remote ? [`echo remote=$(git ls-remote origin ${ref} | cut -f1)`] : []),
  ].join("; ");
}

export function parseKeyValues(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) map.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return map;
}

export function parseBranchProbe(stdout: string): ProbedState {
  const kv = parseKeyValues(stdout);
  const current = kv.get("current");
  if (!current) throw new Error("branch probe returned no current branch (not a git checkout?)");
  const nonEmpty = (k: string) => {
    const v = kv.get(k) ?? "";
    return v === "" ? null : v;
  };
  return {
    current,
    local: nonEmpty("local"),
    dirty: (kv.get("dirty") ?? "") !== "",
    head: kv.get("head") ?? "",
    clean: (kv.get("dirty") ?? "") === "" && (kv.get("changes") ?? "") === "",
    merged: kv.get("merged") === "yes",
    remote: nonEmpty("remote"),
  };
}
