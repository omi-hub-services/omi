// OMI-003: opt-in subscription PoC; never imported by the OMI-014 adapter.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildWorkerEnv,
  classify,
  diagnosticCategory,
  FORBIDDEN_AUTH_ENV,
  redactText,
  runCodex,
  summarizeEvent,
  type CliRun,
} from "./codex-cli-process.js";
import { resultSchema, subscriptionAuthMode, validateResult } from "./codex-worker-result.js";

const profile = process.env["OMI_LIVE_CODEX_HOME"];
const evidenceDir = resolve(import.meta.dirname, "../../../.tmp/live");
const README = "# Sample\nProject codename: BLUE-HERON-42\n";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=omi-live", "-c", "user.email=omi-live@example.invalid", ...args],
    { cwd, encoding: "utf8", timeout: 10_000 },
  );
  if (result.status !== 0) throw new Error("temporary repository git operation failed");
  return result.stdout;
}

// Live tests stay outside check/CI. An unset variable skips; an explicitly empty/invalid one fails.
// Select this file directly with vitest to avoid the Claude suite's mandatory profile guard.
describe.skipIf(profile === undefined)("OMI-003 Codex subscription worker (live)", () => {
  const cases: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = {
    task: "OMI-003",
    startedAt: new Date().toISOString(),
    cases,
  };
  let repo: string | undefined;
  let artifacts: string | undefined;
  let env: Record<string, string>;
  let schemaPath: string;
  let initialHead: string;

  function saveEvidence(): void {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, "omi-003-codex-subscription-evidence.json"),
      redactText(JSON.stringify(evidence, null, 2)) + "\n",
      { mode: 0o600 },
    );
  }

  beforeAll(() => {
    if (!profile?.trim()) throw new Error("OMI_LIVE_CODEX_HOME must name a logged-in profile");
    env = buildWorkerEnv(process.env, resolve(profile));
    for (const name of FORBIDDEN_AUTH_ENV) expect(env).not.toHaveProperty(name);
    expect(env["CODEX_HOME"] === resolve(profile)).toBe(true);
    // Credentials exist only in memory during validation, never in an assertion or evidence.
    let authText: string;
    try {
      authText = readFileSync(join(resolve(profile), "auth.json"), "utf8");
    } catch {
      throw new Error("file auth cache unavailable; Coordinator must check profile login");
    }
    evidence["authMode"] = subscriptionAuthMode(authText);
    evidence["authStore"] = "CODEX_HOME/auth.json (file)";
    evidence["childEnvKeys"] = Object.keys(env).sort();
    evidence["forbiddenAuthEnvInChild"] = FORBIDDEN_AUTH_ENV.filter((name) => name in env);
    const version = spawnSync("codex", ["--version"], {
      env,
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 10_000,
    });
    if (version.status !== 0 || !/^codex-cli [0-9]+\.[0-9]+\.[0-9]+\s*$/.test(version.stdout)) {
      throw new Error("codex --version failed or returned an unexpected format");
    }
    evidence["version"] = version.stdout.trim();
    evidence["node"] = process.version;
    evidence["platform"] = process.platform;
    repo = mkdtempSync(join(tmpdir(), "omi-live-codex-repo-"));
    artifacts = mkdtempSync(join(tmpdir(), "omi-live-codex-artifacts-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repo, "README.md"), README);
    writeFileSync(join(repo, "greeting.txt"), "Hello, world\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "initial");
    initialHead = git(repo, "rev-parse", "HEAD");
    schemaPath = join(artifacts, "result-schema.json");
    // One schema definition generates the CLI schema and validates responses.
    writeFileSync(schemaPath, JSON.stringify(z.toJSONSchema(resultSchema)));
    saveEvidence();
  });

  afterAll(() => {
    evidence["finishedAt"] = new Date().toISOString();
    try {
      saveEvidence();
    } finally {
      if (repo) rmSync(repo, { recursive: true, force: true });
      if (artifacts) rmSync(artifacts, { recursive: true, force: true });
    }
  });

  async function run(
    name: string,
    sandbox: "read-only" | "workspace-write",
    prompt: string,
    options: { schema?: string; cancel?: boolean } = {},
  ): Promise<{ run: CliRun; output: string; entry: Record<string, unknown> }> {
    if (!repo || !artifacts) throw new Error("temporary repositories not initialized");
    const output = join(artifacts, `${name}.json`);
    const result = await runCodex({
      args: [
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--json",
        "--color",
        "never",
        "-c",
        'cli_auth_credentials_store="file"',
        "-c",
        'forced_login_method="chatgpt"',
        "-c",
        'model_provider="openai"',
        "-c",
        'approval_policy="never"',
        "-C",
        repo,
        "-s",
        sandbox,
        "--output-schema",
        options.schema ?? schemaPath,
        "-o",
        output,
        "-",
      ],
      prompt,
      cwd: repo,
      env,
      timeoutMs: 180_000,
      ...(options.cancel
        ? {
            cancelOn: {
              eventType: "turn.started",
              delayMs: 100,
              signal: "SIGINT" as const,
              graceMs: 15_000,
            },
          }
        : {}),
    });
    const entry: Record<string, unknown> = {
      name,
      outcome: classify(result),
      exitCode: result.exitCode,
      signal: result.signal,
      sandbox,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      outputLimitExceeded: result.outputLimitExceeded,
      cancel: result.cancel,
      groupAliveAtClose: result.groupAliveAtClose,
      unparsedStdoutLines: result.unparsedStdoutLines,
      diagnostic: diagnosticCategory(result.stderr),
      checksPassed: false,
    };
    cases.push(entry);
    // No message bodies, commands, IDs or raw diagnostics enter evidence.
    writeFileSync(
      join(evidenceDir, `omi-003-${name}.events.jsonl`),
      result.events.map((e) => JSON.stringify(summarizeEvent(e))).join("\n") + "\n",
      { mode: 0o600 },
    );
    saveEvidence();
    expect(result.timedOut, "CLI exceeded hard deadline").toBe(false);
    expect(result.outputLimitExceeded).toBe(false);
    expect(result.groupAliveAtClose, "process group survived worker exit").toBe(false);
    return { run: result, output, entry };
  }

  function checkDisk(edited: boolean): void {
    if (!repo) throw new Error("missing temp repo");
    // Include ignored files and check HEAD, so hidden artifacts or a worker commit cannot pass.
    expect(
      git(repo, "status", "--porcelain", "--untracked-files=all", "--ignored").trim() ===
        (edited ? "M greeting.txt" : ""),
    ).toBe(true);
    expect(git(repo, "rev-parse", "HEAD") === initialHead).toBe(true);
    expect(readFileSync(join(repo, "README.md"), "utf8") === README).toBe(true);
    expect(
      readFileSync(join(repo, "greeting.txt"), "utf8") ===
        (edited ? "Hello, omi\n" : "Hello, world\n"),
    ).toBe(true);
  }

  // Stop on the first failure: a sandbox/auth startup failure must not trigger more model runs.
  it("proves subscription read, edit, structured output, schema error and SIGINT cancellation", async () => {
    const read = await run(
      "read-only",
      "read-only",
      "Read README.md and report its project codename. Make no changes. Return codename and an empty changedFiles array.",
    );
    expect(classify(read.run), `read-only diagnostic: ${diagnosticCategory(read.run.stderr)}`).toBe(
      "success",
    );
    const readResult = validateResult(readFileSync(read.output, "utf8"));
    expect(readResult.codename === "BLUE-HERON-42" && readResult.changedFiles.length === 0).toBe(
      true,
    );
    checkDisk(false);
    read.entry["checksPassed"] = true;
    read.entry["structuredResultValid"] = true;
    saveEvidence();

    const edit = await run(
      "edit",
      "workspace-write",
      "Read README.md for the codename. Replace world with omi in greeting.txt. Change nothing else; do not commit. Return codename and changedFiles containing greeting.txt.",
    );
    expect(classify(edit.run), `edit diagnostic: ${diagnosticCategory(edit.run.stderr)}`).toBe(
      "success",
    );
    const editResult = validateResult(readFileSync(edit.output, "utf8"));
    expect(
      editResult.codename === "BLUE-HERON-42" &&
        JSON.stringify(editResult.changedFiles) === '["greeting.txt"]',
    ).toBe(true);
    checkDisk(true);
    edit.entry["checksPassed"] = true;
    edit.entry["structuredResultValid"] = true;
    saveEvidence();

    if (!artifacts) throw new Error("missing artifacts");
    const invalid = join(artifacts, "invalid-schema.json");
    writeFileSync(invalid, "{invalid JSON");
    const error = await run("error-schema", "read-only", "Reply OK", { schema: invalid });
    expect(classify(error.run)).toBe("error");
    expect(error.run.exitCode !== null && error.run.exitCode !== 0).toBe(true);
    expect(
      diagnosticCategory(error.run.stderr) === "invalid-schema",
      "error must identify schema parsing, rather than unrelated startup reasons",
    ).toBe(true);
    expect(error.run.cancel).toBeUndefined();
    checkDisk(true);
    error.entry["checksPassed"] = true;
    saveEvidence();

    const cancel = await run(
      "cancel",
      "read-only",
      "Without tools, reason through a detailed 5000-word history of version control before returning the requested JSON.",
      { cancel: true },
    );
    expect(cancel.run.cancel, "turn.started never triggered cancellation").toBeDefined();
    expect(classify(cancel.run)).toBe("cancelled");
    expect(cancel.run.cancel?.escalated).toBe(false);
    expect(cancel.run.cancel?.exitAfterSignalMs).toBeLessThan(15_000);
    checkDisk(true);
    cancel.entry["checksPassed"] = true;
    evidence["allChecksPassed"] = true;
    saveEvidence();
  }, 760_000);
});
