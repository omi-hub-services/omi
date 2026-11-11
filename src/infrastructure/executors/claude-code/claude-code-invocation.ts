import type {
  AccessLevel,
  ExecutionRequest,
} from "../../../application/contracts/agent-execution.js";

export type SettingSource = "user" | "project" | "local";

/**
 * Settings layers a worker loads. `user` is the profile's own `settings.json`: its hooks,
 * permission rules and default model run inside `-p` and made profiles behave differently
 * (ADR-0013 findings 3 and 4). Workers load only the task worktree's `project` and `local`
 * layers, so CLAUDE.md and project settings of the trusted worktree still apply. ADR-0023.
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
