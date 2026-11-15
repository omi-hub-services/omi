// OMI-002 — PoC: a non-interactive Claude Code worker on a subscription login reads and edits a
// temporary git repository. Opt-in: `OMI_LIVE_CLAUDE_CONFIG_DIR=<profile dir> npm run test:live`.
// Never part of `npm run check` or CI. Evidence (redacted) goes to `.tmp/live/`.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorkerEnv,
  type CliRun,
  findEvent,
  FORBIDDEN_AUTH_ENV,
  redactText,
  runClaude,
  stringArrayField,
  stringField,
  summarizeEvent,
  toolUseNames,
} from "./claude-cli-process.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const evidenceDir = join(repoRoot, ".tmp/live");

function requireConfigDir(): string {
  const value = process.env["OMI_LIVE_CLAUDE_CONFIG_DIR"];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      "OMI_LIVE_CLAUDE_CONFIG_DIR is required for the live Claude Code test. Set it to a " +
        "logged-in Claude Code profile directory (CLAUDE_CONFIG_DIR), e.g. " +
        "OMI_LIVE_CLAUDE_CONFIG_DIR=$HOME/.claude-profiles/b npm run test:live",
    );
  }
  const dir = resolve(value);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`OMI_LIVE_CLAUDE_CONFIG_DIR does not point to a directory: ${dir}`);
  }
  return dir;
}

const configDir = requireConfigDir();
const workerEnv = buildWorkerEnv(process.env, configDir);

const CODENAME = "BLUE-HERON-42";
const CASE_TIMEOUT_MS = 240_000;
const RUN_TIMEOUT_MS = 180_000;
const CANCEL_GRACE_MS = 15_000;

/** Flags shared by every worker run. See ADR-0013 for why each one is chosen. */
const BASE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--strict-mcp-config",
] as const;

type Outcome = "success" | "error" | "cancelled";

interface CaseEvidence {
  name: string;
  outcome: Outcome;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  sessionId: string | undefined;
  model: string | undefined;
  permissionMode: string | undefined;
  apiKeySource: string | undefined;
  availableTools: string[];
  toolsUsed: string[];
  resultSubtype: string | undefined;
  resultIsError: boolean | undefined;
  numTurns: number | undefined;
  resultExcerpt: string | undefined;
  stderrExcerpt: string | undefined;
  cancel: CliRun["cancel"];
  groupAliveAtClose: boolean;
  eventCount: number;
  unparsedStdoutLines: number;
  checks: Record<string, unknown>;
}

const evidence: {
  task: string;
  startedAt: string;
  finishedAt?: string;
  environment: Record<string, string | undefined>;
  childEnvKeys: string[];
  forbiddenAuthEnvInChild: string[];
  authStatus: Record<string, unknown>;
  cases: CaseEvidence[];
} = {
  task: "OMI-002",
  startedAt: new Date().toISOString(),
  environment: {},
  childEnvKeys: Object.keys(workerEnv).sort(),
  forbiddenAuthEnvInChild: FORBIDDEN_AUTH_ENV.filter((name) => name in workerEnv),
  authStatus: {},
  cases: [],
};

function commandOutput(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false, env: workerEnv });
  return `${result.stdout}${result.stderr}`.trim();
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=omi-live", "-c", "user.email=omi-live@example.invalid", ...args],
    { cwd, encoding: "utf8", shell: false },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "omi-live-claude-"));
  git(dir, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, "README.md"), `# Sample\n\nProject codename: ${CODENAME}\n`);
  writeFileSync(join(dir, "greeting.txt"), "Hello, world\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

/** Only allowlisted, non-identifying fields of `claude auth status --json` are kept. */
function readAuthStatus(): Record<string, unknown> {
  const result = spawnSync("claude", ["auth", "status", "--json"], {
    encoding: "utf8",
    shell: false,
    env: workerEnv,
    cwd: tmpdir(),
  });
  const kept: Record<string, unknown> = { exitCode: result.status };
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      kept["fieldNames"] = Object.keys(record).sort();
      for (const key of ["loggedIn", "authMethod", "apiProvider", "subscriptionType", "planTier"]) {
        const value = record[key];
        if (typeof value === "string" || typeof value === "boolean") kept[key] = value;
      }
    }
  } catch {
    kept["parseError"] = "stdout was not JSON";
  }
  return kept;
}

// Neither signal alone is enough (OMI-002 live run, Claude Code 2.1.322): an unknown model gave
// `result.subtype == "success"` with `is_error: true` and exit 1, and a SIGINT-cancelled run
// exited 0 with `subtype: "error_during_execution"`. Success needs all three.
function classify(run: CliRun): Outcome {
  const result = findEvent(run, "result");
  const succeeded =
    run.exitCode === 0 && result?.["subtype"] === "success" && result["is_error"] !== true;
  if (run.cancel !== undefined && !succeeded) return "cancelled";
  return succeeded ? "success" : "error";
}

function excerpt(text: string | undefined, max = 300): string | undefined {
  if (text === undefined || text === "") return undefined;
  const redacted = redactText(text);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

function record(name: string, run: CliRun, checks: Record<string, unknown> = {}): CaseEvidence {
  const init = findEvent(run, "system", "init");
  const result = findEvent(run, "result");
  const numTurns = result?.["num_turns"];
  const isError = result?.["is_error"];
  const entry: CaseEvidence = {
    name,
    outcome: classify(run),
    exitCode: run.exitCode,
    signal: run.signal,
    durationMs: run.durationMs,
    sessionId: stringField(init, "session_id"),
    model: stringField(init, "model"),
    permissionMode: stringField(init, "permissionMode"),
    apiKeySource: stringField(init, "apiKeySource"),
    availableTools: stringArrayField(init, "tools"),
    toolsUsed: toolUseNames(run),
    resultSubtype: stringField(result, "subtype"),
    resultIsError: typeof isError === "boolean" ? isError : undefined,
    numTurns: typeof numTurns === "number" ? numTurns : undefined,
    resultExcerpt: excerpt(stringField(result, "result")),
    stderrExcerpt: excerpt(run.stderr.trim(), 600),
    cancel: run.cancel,
    groupAliveAtClose: run.groupAliveAtClose,
    eventCount: run.events.length,
    unparsedStdoutLines: run.unparsedStdoutLines,
    checks,
  };
  evidence.cases.push(entry);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, `omi-002-${name}.events.jsonl`),
    run.events.map((event) => JSON.stringify(summarizeEvent(event))).join("\n") + "\n",
  );
  return entry;
}

describe("OMI-002 Claude Code subscription worker (live)", () => {
  let repo: string;

  beforeAll(() => {
    repo = createTempRepo();
    evidence.environment = {
      claudeCode: commandOutput("claude", ["--version"]),
      node: process.version,
      git: commandOutput("git", ["--version"]),
      gh: commandOutput("gh", ["--version"]).split("\n")[0],
      platform: `${process.platform} ${commandOutput("uname", ["-r"])}`,
      os: readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="(.*)"$/m)?.[1],
    };
    evidence.authStatus = readAuthStatus();
  });

  afterAll(() => {
    evidence.finishedAt = new Date().toISOString();
    mkdirSync(evidenceDir, { recursive: true });
    const file = join(evidenceDir, "omi-002-claude-subscription-evidence.json");
    writeFileSync(file, redactText(JSON.stringify(evidence, null, 2)) + "\n");
    rmSync(repo, { recursive: true, force: true });
  });

  it("builds a child env without API keys or tokens", () => {
    for (const name of FORBIDDEN_AUTH_ENV) expect(workerEnv).not.toHaveProperty(name);
    expect(Object.keys(workerEnv).filter((key) => key.startsWith("ANTHROPIC_"))).toEqual([]);
    expect(workerEnv["CLAUDE_CONFIG_DIR"]).toBe(configDir);
    expect(evidence.authStatus["exitCode"]).toBe(0);
    // Subscription (claude.ai OAuth) login on the first-party API, not an API key or 3P provider.
    expect(evidence.authStatus["loggedIn"]).toBe(true);
    expect(evidence.authStatus["authMethod"]).toBe("claude.ai");
    expect(evidence.authStatus["apiProvider"]).toBe("firstParty");
  });

  it(
    "read-only step answers a question about the temp repo without changing it",
    async () => {
      const tools = "Read,Grep,Glob";
      const run = await runClaude({
        args: [
          ...BASE_ARGS,
          "--tools",
          tools,
          "--allowedTools",
          tools,
          "--permission-mode",
          "dontAsk",
          "--max-turns",
          "6",
        ],
        prompt:
          "Read README.md in the current directory. What is the project codename? " +
          "Reply with the codename only.",
        cwd: repo,
        env: workerEnv,
        timeoutMs: RUN_TIMEOUT_MS,
      });
      const status = git(repo, "status", "--porcelain");
      const entry = record("read-only", run, { gitStatusAfter: status });
      const answer = stringField(findEvent(run, "result"), "result") ?? "";

      expect(entry.outcome, entry.stderrExcerpt).toBe("success");
      expect(entry.apiKeySource).toBe("none");
      expect(answer).toContain(CODENAME);
      expect(entry.availableTools).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(Edit|Write|Bash|NotebookEdit)$/)]),
      );
      expect(entry.toolsUsed.every((name) => ["Read", "Grep", "Glob"].includes(name))).toBe(true);
      expect(status).toBe("");
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "edit step changes a file in the temp repo, verified on disk",
    async () => {
      const tools = "Read,Edit,Write,Glob,Grep";
      const run = await runClaude({
        args: [
          ...BASE_ARGS,
          "--tools",
          tools,
          "--allowedTools",
          tools,
          "--permission-mode",
          "acceptEdits",
          "--max-turns",
          "8",
        ],
        prompt:
          "In greeting.txt in the current directory, replace the word 'world' with 'omi'. " +
          "Change nothing else and do not create other files. Reply 'done' when finished.",
        cwd: repo,
        env: workerEnv,
        timeoutMs: RUN_TIMEOUT_MS,
      });
      const content = readFileSync(join(repo, "greeting.txt"), "utf8");
      const status = git(repo, "status", "--porcelain");
      const entry = record("edit", run, { greetingAfter: content, gitStatusAfter: status });

      expect(entry.outcome, entry.stderrExcerpt).toBe("success");
      expect(entry.apiKeySource).toBe("none");
      expect(entry.permissionMode).toBe("acceptEdits");
      expect(content.trimEnd()).toBe("Hello, omi");
      expect(status.trim()).toBe("M greeting.txt");
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "error case: an unknown model yields a classified non-success result",
    async () => {
      const run = await runClaude({
        args: [
          ...BASE_ARGS,
          "--tools",
          "",
          "--model",
          "omi-nonexistent-model-0",
          "--max-turns",
          "1",
        ],
        prompt: "Reply with OK.",
        cwd: repo,
        env: workerEnv,
        timeoutMs: RUN_TIMEOUT_MS,
      });
      const entry = record("error-invalid-model", run);

      expect(entry.outcome).toBe("error");
      expect(run.exitCode).not.toBe(0);
      expect(entry.resultIsError).toBe(true);
      expect(entry.apiKeySource).toBe("none");
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "cancel case: SIGINT during a long run ends the process within the grace period",
    async () => {
      const run = await runClaude({
        args: [...BASE_ARGS, "--tools", "", "--max-turns", "1"],
        prompt:
          "Without using any tools, write a detailed 3000-word essay on the history of " +
          "version control systems, with numbered sections.",
        cwd: repo,
        env: workerEnv,
        timeoutMs: RUN_TIMEOUT_MS,
        cancelOn: {
          eventType: "system",
          eventSubtype: "init",
          delayMs: 3_000,
          signal: "SIGINT",
          graceMs: CANCEL_GRACE_MS,
        },
      });
      const entry = record("cancel-sigint", run);

      expect(run.cancel, "the cancel signal was never sent").toBeDefined();
      expect(entry.outcome).toBe("cancelled");
      expect(entry.apiKeySource).toBe("none");
      expect(entry.resultIsError).toBe(true);
      expect(run.cancel?.escalated).toBe(false);
      expect(run.cancel?.exitAfterSignalMs).toBeLessThan(CANCEL_GRACE_MS);
      expect(run.groupAliveAtClose).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );
});
