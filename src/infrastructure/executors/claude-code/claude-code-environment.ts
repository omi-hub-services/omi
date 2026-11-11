/** Variables copied from the parent environment into a worker. Everything else is dropped. */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

/** Variables that would let the CLI authenticate with something other than the profile login. */
export const FORBIDDEN_AUTH_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/**
 * The complete environment of one Claude Code process. The profile is chosen here, per process,
 * with `CLAUDE_CONFIG_DIR`; no global login is ever swapped, so runs on different profiles can
 * overlap (architecture.md §7).
 *
 * An allowlist (not a denylist) keeps API keys, OAuth tokens and the parent Claude Code session's
 * `CLAUDECODE` / `CLAUDE_CODE_*` variables out of the worker (ADR-0013). `DISABLE_AUTOUPDATER`
 * keeps the CLI version fixed for the duration of a run.
 */
export function buildClaudeCodeEnvironment(
  parent: NodeJS.ProcessEnv,
  profileHome: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  env["CLAUDE_CONFIG_DIR"] = profileHome;
  env["DISABLE_AUTOUPDATER"] = "1";
  return env;
}
