import type {
  AccessLevel,
  ExecutionRequest,
} from "../../../application/contracts/agent-execution.js";

export type SettingSource = "user" | "project" | "local";

/**
 * Settings layers a worker loads. `user` is the profile's own `settings.json`: its hooks,
 * permission rules and default model run inside `-p` and made profiles behave differently
 * (ADR-0013 findings 3 and 4), and so do the plugins the profile enables there. Workers load
 * only the task worktree's `project` and `local` layers, so CLAUDE.md and project settings of
 * the trusted worktree still apply. ADR-0023, ADR-0019 (decision update 2026-11-11).
 */
export const DEFAULT_SETTING_SOURCES: readonly SettingSource[] = ["project", "local"];

interface AccessFlags {
  tools: string;
  permissionMode: string;
}

/**
 * `--tools` limits which built-in tools exist; `--allowedTools` pre-approves exactly those; the
 * permission mode decides everything else. Neither level can run shell commands, and neither
 * uses `bypassPermissions` (ADR-0013).
 */
const ACCESS_FLAGS: Record<AccessLevel, AccessFlags> = {
  "read-only": { tools: "Read,Grep,Glob", permissionMode: "dontAsk" },
  "workspace-write": { tools: "Read,Edit,Write,Glob,Grep", permissionMode: "acceptEdits" },
};

export interface ClaudeInvocationOptions {
  settingSources?: readonly SettingSource[];
}

/**
 * Argument vector of one worker run (the prompt goes to stdin, so no argument is positional and
 * the variadic `--tools` / `--allowedTools` cannot swallow it). No `--bare`: it never reads the
 * subscription login (ADR-0013). `--model` and `--effort` are always explicit because the
 * default model differs per profile.
 */
export function buildClaudeInvocationArgs(
  request: Pick<ExecutionRequest, "model" | "effort" | "access">,
  options: ClaudeInvocationOptions = {},
): string[] {
  const access = ACCESS_FLAGS[request.access];
  const sources = options.settingSources ?? DEFAULT_SETTING_SOURCES;
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    // Workers get their skills inlined in the prompt; no native skill may be listed (OMI-072).
    "--disable-slash-commands",
    "--setting-sources",
    sources.join(","),
    "--model",
    request.model,
    "--effort",
    request.effort,
    "--tools",
    access.tools,
    "--allowedTools",
    access.tools,
    "--permission-mode",
    access.permissionMode,
  ];
}

// Explicit transitional source-maintenance policy (ADR-0036), never the runtime default.
/** Default worker tool allowlist for every task (omi-next step 3, ADR-0014). */
export const REPOSITORY_WORKER_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  "TodoWrite",
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(git log*)",
  "Bash(git show*)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git switch *)",
  "Bash(git fetch*)",
  "Bash(git rev-parse *)",
  "Bash(git restore *)",
  "Bash(git ls-files*)",
  "Bash(git grep *)",
  "Bash(npm run *)",
  "Bash(npm ci)",
  "Bash(node *)",
  "Bash(gh issue view *)",
  "Bash(gh issue list *)",
  "Bash(gh pr view *)",
  "Bash(gh pr list *)",
  "Bash(gh pr diff *)",
  "Bash(gh project item-list *)",
  "Bash(gh project field-list *)",
  "Bash(gh project view *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(mkdir *)",
  "Bash(ps *)",
] as const;

/** Wins over the allowlist; flag-first forms only (known gap, ADR-0014). */
export const REPOSITORY_WORKER_DENIED_TOOLS = [
  "Bash(git push*)",
  "Bash(git reset --hard*)",
  "Bash(gh api*)",
  "Bash(npm install*)",
  "Bash(git commit --no-verify*)",
  "Bash(git commit -n*)",
  "Bash(git commit --amend*)",
  "Bash(git switch --discard-changes*)",
  "Bash(git switch -C*)",
  "Bash(git switch -f*)",
  "Bash(git switch --force*)",
] as const;
