// OMI-004 — live: a Codex profile (`CODEX_HOME`) is separate from the default `~/.codex`, and
// two Codex workers can run at the same time on the same profile without breaking its login.
//
// Opt-in, never part of `npm run check` or CI. Unset: the suite is skipped.
//   OMI_LIVE_CODEX_HOME=<CODEX_HOME> vitest run tests/live/multi-profile/codex-profile-isolation.test.ts
// Optional: OMI_LIVE_CODEX_MODEL (default gpt-6-luna), effort low.
//
// Only one Codex profile exists (PO decision 2026-11-11), so failover between two Codex profiles
// is NOT exercised here and is recorded as not proven in ADR-0031. Auth files are only hashed
// in memory; their bytes, tokens and account ids never reach evidence or assertions messages.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ExecutionEvent,
  ExecutionResult,
} from "../../../src/application/contracts/agent-execution.js";
import { inspectCodexAuth } from "../../../src/infrastructure/executors/codex/codex-auth.js";
import { buildCodexEnvironment } from "../../../src/infrastructure/executors/codex/codex-environment.js";
import { CodexExecutor } from "../../../src/infrastructure/executors/codex/codex-executor.js";
import { redactText } from "../codex-cli/codex-cli-process.js";

const raw = process.env["OMI_LIVE_CODEX_HOME"];
const MODEL = process.env["OMI_LIVE_CODEX_MODEL"] ?? "gpt-6-luna";
const evidenceDir = resolve(import.meta.dirname, "../../../.tmp/live");

interface AuthFileFacts {
  present: boolean;
  /** Compare only; never recorded. */
  digest?: string;
  mtimeMs?: number;
  /** `last_refresh` timestamp written by the CLI when it refreshes tokens. Not a secret. */
  lastRefresh?: string;
}

function authFile(home: string): AuthFileFacts {
  const path = join(home, "auth.json");
  if (!existsSync(path)) return { present: false };
  const bytes = readFileSync(path);
  const facts: AuthFileFacts = {
    present: true,
    digest: createHash("sha256").update(bytes).digest("hex"),
    mtimeMs: statSync(path).mtimeMs,
  };
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>)["last_refresh"];
      if (typeof value === "string" && value.length <= 64) facts.lastRefresh = value;
    }
  } catch {
    // Unparsable cache: reported through inspectCodexAuth.
  }
  return facts;
}

function loginStatus(env: Record<string, string>): { exitCode: number | null; state: string } {
  const result = spawnSync("codex", ["login", "status"], {
    env,
    cwd: tmpdir(),
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });
  const text = `${result.stdout}\n${result.stderr}`;
  const state = /logged in using chatgpt/i.test(text)
    ? "chatgpt"
    : /not logged in/i.test(text)
      ? "not-logged-in"
      : /api key/i.test(text)
        ? "api-key"
        : "other";
  return { exitCode: result.status, state };
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "omi-004-codex-"));
  const git = (...args: string[]) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=omi-live", "-c", "user.email=omi-live@example.invalid", ...args],
      { cwd: dir, encoding: "utf8", timeout: 10_000 },
    );
    if (result.status !== 0) throw new Error("temporary repository git operation failed");
  };
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, "README.md"), "# Sample\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial");
  return dir;
}

describe.skipIf(raw === undefined)("OMI-004 Codex profile isolation and concurrency (live)", () => {
  let profile: string;
  const repos: string[] = [];
  const evidence: Record<string, unknown> = {
    task: "OMI-004",
    suite: "codex-profile-isolation",
    startedAt: new Date().toISOString(),
    model: MODEL,
  };

  function save(): void {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, "omi-004-codex-isolation-evidence.json"),
      redactText(JSON.stringify(evidence, null, 2)) + "\n",
      { mode: 0o600 },
    );
  }

  beforeAll(() => {
    if (raw === undefined || raw.trim() === "")
      throw new Error("OMI_LIVE_CODEX_HOME must name a profile");
    profile = resolve(raw);
    if (!existsSync(profile) || !statSync(profile).isDirectory()) {
      throw new Error("OMI_LIVE_CODEX_HOME does not point to a directory");
    }
  });

  afterAll(() => {
    evidence["finishedAt"] = new Date().toISOString();
    save();
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  });

  it("reads the login from CODEX_HOME, not from the default ~/.codex (no model call)", async () => {
    const defaultHome = join(homedir(), ".codex");
    const env = buildCodexEnvironment(process.env, profile);
    const defaultEnv = buildCodexEnvironment(process.env, defaultHome);
    delete defaultEnv["CODEX_HOME"];
    const empty = mkdtempSync(join(tmpdir(), "omi-004-empty-codex-home-"));
    let emptyStatus: ReturnType<typeof loginStatus>;
    try {
      emptyStatus = loginStatus(buildCodexEnvironment(process.env, empty));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const facts = {
      separateFromDefault:
        !existsSync(defaultHome) || realpathSync(defaultHome) !== realpathSync(profile),
      profileLogin: loginStatus(env),
      defaultLogin: loginStatus(defaultEnv),
      emptyHomeLogin: emptyStatus,
      profileCache: await inspectCodexAuth(profile),
      defaultCachePresent: authFile(defaultHome).present,
    };
    evidence["namespace"] = facts;
    save();

    expect(facts.separateFromDefault).toBe(true);
    expect(facts.profileLogin).toEqual({ exitCode: 0, state: "chatgpt" });
    expect(facts.profileCache).toBe("ready");
    expect(facts.emptyHomeLogin.state).toBe("not-logged-in");
  });

  it("runs two workers on the same profile at once; the login stays valid and ~/.codex untouched", async () => {
    const defaultHome = join(homedir(), ".codex");
    const before = { profile: authFile(profile), default: authFile(defaultHome) };
    const executor = new CodexExecutor();
    const probe = await executor.probe({ profileHome: profile });
    evidence["probe"] = { status: probe.status, version: probe.version };
    save();
    expect(probe.status).toBe("ready");

    const origin = performance.now();
    const runOne = async (attemptId: string) => {
      const workspace = tempRepo();
      repos.push(workspace);
      const startMs = performance.now() - origin;
      const handle = await executor.start({
        attemptId,
        workspace,
        profileHome: profile,
        prompt: "Reply with OK only. Do not run any command.",
        model: MODEL,
        effort: "low",
        access: "read-only",
        timeoutMs: 180_000,
      });
      const result: ExecutionResult = await executor.collectResult(handle);
      const quota: Extract<ExecutionEvent, { kind: "quota-signal" }>[] = [];
      for await (const event of executor.events(handle)) {
        if (event.kind === "quota-signal") quota.push(event);
      }
      return { result, quota, startMs, endMs: performance.now() - origin };
    };
    const [one, two] = await Promise.all([
      runOne("codex-concurrent-1"),
      runOne("codex-concurrent-2"),
    ]);
    const after = { profile: authFile(profile), default: authFile(defaultHome) };
    const cacheAfter = await inspectCodexAuth(profile);
    const loginAfter = loginStatus(buildCodexEnvironment(process.env, profile));
    const runs = [one, two].map(({ result, quota, startMs, endMs }) => ({
      attemptId: result.attemptId,
      outcome: result.outcome,
      reason: result.reason,
      exitCode: result.exitCode,
      authMode: result.authMode,
      sessionId: result.sessionId,
      numTurns: result.numTurns,
      durationMs: Math.round(result.durationMs),
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      toolsUsed: result.toolsUsed,
      quotaSignals: quota,
      diagnostic: result.diagnostic,
    }));
    const overlapMs = Math.round(
      Math.min(one.endMs, two.endMs) - Math.max(one.startMs, two.startMs),
    );
    evidence["concurrency"] = {
      runs,
      overlapMs,
      authCacheChanged: before.profile.digest !== after.profile.digest,
      lastRefreshBefore: before.profile.lastRefresh,
      lastRefreshAfter: after.profile.lastRefresh,
      cacheAfter,
      loginAfter,
      defaultCacheUnchanged:
        before.default.present === after.default.present &&
        before.default.digest === after.default.digest,
    };
    save();

    for (const entry of runs) {
      expect(entry.outcome, entry.diagnostic).toBe("succeeded");
      expect(entry.authMode).toBe("subscription");
    }
    expect(runs[0]?.sessionId).not.toBe(runs[1]?.sessionId);
    expect(overlapMs, "the two runs did not overlap").toBeGreaterThan(0);
    expect(cacheAfter).toBe("ready");
    expect(loginAfter).toEqual({ exitCode: 0, state: "chatgpt" });
    expect(evidence["concurrency"]).toMatchObject({ defaultCacheUnchanged: true });
  }, 420_000);
});
