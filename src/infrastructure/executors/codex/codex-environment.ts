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

export const FORBIDDEN_AUTH_ENV = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_AUTH_TOKEN",
  "OPENAI_BASE_URL",
] as const;

/** Complete per-process environment; no parent session, credential or provider overrides. */
export function buildCodexEnvironment(
  parent: NodeJS.ProcessEnv,
  profileHome: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  env["CODEX_HOME"] = profileHome;
  return env;
}
