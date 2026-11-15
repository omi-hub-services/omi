// OMI-004 live support: facts about one Claude Code profile namespace that cost no model quota.
// Test-only. Reads credential files' metadata (lstat), never their content; account identifiers
// from `claude auth status` stay in memory as a digest used only for comparison.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeCodeEnvironment } from "../../../src/infrastructure/executors/claude-code/claude-code-environment.js";

export interface ClaudeAuthFacts {
  exitCode: number | null;
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  /**
   * sha256 of the account identifiers. Compare only: never write it to evidence, because a
   * digest of an e-mail address can be guessed.
   */
  accountDigest?: string;
}

/** Environment for the default profile: the production allowlist without `CLAUDE_CONFIG_DIR`. */
export function defaultProfileEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env = buildClaudeCodeEnvironment(parent, tmpdir());
  delete env["CLAUDE_CONFIG_DIR"];
  return env;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= 128 ? value : undefined;
}

/** `claude auth status --json` for one environment; spends no model quota. */
export function readClaudeAuth(env: Record<string, string>): ClaudeAuthFacts {
  const result = spawnSync("claude", ["auth", "status", "--json"], {
    env,
    cwd: tmpdir(),
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });
  const facts: ClaudeAuthFacts = { exitCode: result.status };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return facts;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return facts;
  const record = parsed as Record<string, unknown>;
  if (typeof record["loggedIn"] === "boolean") facts.loggedIn = record["loggedIn"];
  const authMethod = str(record["authMethod"]);
  const apiProvider = str(record["apiProvider"]);
  const subscriptionType = str(record["subscriptionType"]);
  if (authMethod !== undefined) facts.authMethod = authMethod;
  if (apiProvider !== undefined) facts.apiProvider = apiProvider;
  if (subscriptionType !== undefined) facts.subscriptionType = subscriptionType;
  const email = str(record["email"]);
  const orgId = str(record["orgId"]);
  if (email !== undefined || orgId !== undefined) {
    facts.accountDigest = createHash("sha256")
      .update(`${orgId ?? ""}\u0000${email ?? ""}`)
      .digest("hex");
  }
  return facts;
}

export interface FileIdentity {
  present: boolean;
  /** Permission bits, e.g. `600`. */
  mode?: string;
  /** `dev:ino`, compare only. */
  inode?: string;
  isSymlink?: boolean;
}

/** Metadata of the profile's credential file (Linux: `CLAUDE_CONFIG_DIR/.credentials.json`). */
export function credentialFileIdentity(profileHome: string): FileIdentity {
  const path = join(profileHome, ".credentials.json");
  if (!existsSync(path)) return { present: false };
  const stat = lstatSync(path);
  return {
    present: true,
    mode: (stat.mode & 0o777).toString(8),
    inode: `${String(stat.dev)}:${String(stat.ino)}`,
    isSymlink: stat.isSymbolicLink(),
  };
}

/**
 * Paths of the transcript `<sessionId>.jsonl` under `<profile>/projects/<project>/`. The CLI
 * stores persisted sessions there; two levels are enough and keep the scan bounded.
 */
export function findSessionTranscripts(profileHome: string, sessionId: string): string[] {
  const projects = join(profileHome, "projects");
  if (!existsSync(projects)) return [];
  const found: string[] = [];
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const candidate = join(projects, project.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) found.push(candidate);
  }
  return found;
}
