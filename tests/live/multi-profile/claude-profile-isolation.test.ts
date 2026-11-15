// OMI-004 — live: two Claude Code subscription profiles are separate namespaces (config,
// credential, session) and run at the same time, each with its own `rate_limit_event`.
//
// Opt-in, never part of `npm run check` or CI. Both variables unset: the suite is skipped.
//   OMI_LIVE_CLAUDE_PROFILE_A=<CLAUDE_CONFIG_DIR> OMI_LIVE_CLAUDE_PROFILE_B=<CLAUDE_CONFIG_DIR> \
//     vitest run tests/live/multi-profile/claude-profile-isolation.test.ts
// Profile A also runs the persisted-session case (one more turn); B only tries to resume it,
// which is expected to fail before any model call. Evidence (redacted) goes to `.tmp/live/`.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildClaudeCodeEnvironment } from "../../../src/infrastructure/executors/claude-code/claude-code-environment.js";
import { buildClaudeInvocationArgs } from "../../../src/infrastructure/executors/claude-code/claude-code-invocation.js";
import {
  findEvent,
  redactText,
  runClaude,
  stringField,
  summarizeEvent,
  type CliRun,
} from "../claude-code/claude-cli-process.js";
import {
  credentialFileIdentity,
  defaultProfileEnv,
  findSessionTranscripts,
  readClaudeAuth,
} from "./claude-profile-namespace.js";
import {
  collectQuotaObservations,
  isRejected,
  perModelWindowNames,
  type QuotaObservation,
} from "./rate-limit-windows.js";

const rawA = process.env["OMI_LIVE_CLAUDE_PROFILE_A"];
const rawB = process.env["OMI_LIVE_CLAUDE_PROFILE_B"];
const MODEL = process.env["OMI_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5";
const evidenceDir = resolve(import.meta.dirname, "../../../.tmp/live");
const RUN_TIMEOUT_MS = 120_000;
const PROMPT = "Reply with OK only.";

function profileDir(raw: string | undefined, name: string): string {
  if (raw === undefined || raw.trim() === "") throw new Error(`${name} must name a profile`);
  const dir = resolve(raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`${name} does not point to a directory`);
  }
  return dir;
}

/** Same argv as the production adapter, with the persistence flag optionally removed. */
function workerArgs(options: { persist?: boolean; resume?: string } = {}): string[] {
  const args = buildClaudeInvocationArgs({ model: MODEL, effort: "low", access: "read-only" });
  const kept =
    options.persist === true ? args.filter((a) => a !== "--no-session-persistence") : args;
  return options.resume === undefined ? kept : [...kept, "--resume", options.resume];
}

interface TimedRun {
  run: CliRun;
  startMs: number;
  endMs: number;
}

async function timed(home: string, cwd: string, args: string[]): Promise<TimedRun> {
  const startMs = performance.now();
  const run = await runClaude({
    args,
    prompt: PROMPT,
    cwd,
    env: buildClaudeCodeEnvironment(process.env, home),
    timeoutMs: RUN_TIMEOUT_MS,
  });
  return { run, startMs, endMs: performance.now() };
}

function succeeded(run: CliRun): boolean {
  const result = findEvent(run, "result");
  return run.exitCode === 0 && result?.["subtype"] === "success" && result["is_error"] !== true;
}

function caseOf(name: string, profile: string, timedRun: TimedRun, origin: number) {
  const { run } = timedRun;
  const init = findEvent(run, "system", "init");
  const result = findEvent(run, "result");
  const quota: QuotaObservation[] = collectQuotaObservations(run.events);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, `omi-004-${name}.events.jsonl`),
    run.events.map((event) => JSON.stringify(summarizeEvent(event))).join("\n") + "\n",
    { mode: 0o600 },
  );
  return {
    name,
    profile,
    success: succeeded(run),
    exitCode: run.exitCode,
    startMs: Math.round(timedRun.startMs - origin),
    endMs: Math.round(timedRun.endMs - origin),
    sessionId: stringField(init, "session_id"),
    model: stringField(init, "model"),
    apiKeySource: stringField(init, "apiKeySource"),
    resultSubtype: stringField(result, "subtype"),
    resultIsError: result?.["is_error"],
    numTurns: result?.["num_turns"],
    assistantEvents: run.events.filter((event) => event.type === "assistant").length,
    quota,
    quotaRejected: isRejected(quota),
    perModelWindows: perModelWindowNames(quota),
    stderrExcerpt:
      run.stderr.trim() === "" ? undefined : redactText(run.stderr.trim()).slice(0, 400),
    resultExcerpt:
      result?.["is_error"] === true
        ? redactText(stringField(result, "result") ?? "").slice(0, 300)
        : undefined,
  };
}

describe.skipIf(rawA === undefined && rawB === undefined)(
  "OMI-004 Claude Code profile isolation (live)",
  () => {
    const evidence: Record<string, unknown> = {
      task: "OMI-004",
      suite: "claude-profile-isolation",
      startedAt: new Date().toISOString(),
      model: MODEL,
      profiles: {
        A: rawA === undefined ? undefined : basename(rawA),
        B: rawB === undefined ? undefined : basename(rawB),
      },
    };
    const cases: Record<string, unknown>[] = [];
    evidence["cases"] = cases;
    let a: string;
    let b: string;
    let cwd: string;
    const origin = performance.now();

    function save(): void {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        join(evidenceDir, "omi-004-claude-isolation-evidence.json"),
        redactText(JSON.stringify(evidence, null, 2)) + "\n",
        { mode: 0o600 },
      );
    }

    beforeAll(() => {
      // PO decision 2026-11-11: no Fable model in OMI-004 live runs.
      if (/fable/i.test(MODEL)) throw new Error("Fable models must not be used for OMI-004");
      a = profileDir(rawA, "OMI_LIVE_CLAUDE_PROFILE_A");
      b = profileDir(rawB, "OMI_LIVE_CLAUDE_PROFILE_B");
      cwd = mkdtempSync(join(tmpdir(), "omi-004-claude-isolation-"));
    });

    afterAll(() => {
      evidence["finishedAt"] = new Date().toISOString();
      save();
      rmSync(cwd, { recursive: true, force: true });
    });

    it("keeps config, credential and login per CLAUDE_CONFIG_DIR (no model call)", () => {
      const defaultDir = join(homedir(), ".claude");
      const realA = realpathSync(a);
      const realB = realpathSync(b);
      const realDefault = existsSync(defaultDir) ? realpathSync(defaultDir) : undefined;
      const credA = credentialFileIdentity(a);
      const credB = credentialFileIdentity(b);
      const authA = readClaudeAuth(buildClaudeCodeEnvironment(process.env, a));
      const authB = readClaudeAuth(buildClaudeCodeEnvironment(process.env, b));
      const authDefault = readClaudeAuth(defaultProfileEnv(process.env));
      const empty = mkdtempSync(join(tmpdir(), "omi-004-empty-profile-"));
      let authEmpty: ReturnType<typeof readClaudeAuth>;
      try {
        authEmpty = readClaudeAuth(buildClaudeCodeEnvironment(process.env, empty));
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
      const namespace = {
        distinctDirectories: realA !== realB,
        defaultIsSeparate: realDefault !== realA && realDefault !== realB,
        credentialFile: {
          A: { present: credA.present, mode: credA.mode, isSymlink: credA.isSymlink },
          B: { present: credB.present, mode: credB.mode, isSymlink: credB.isSymlink },
          sameInode: credA.inode !== undefined && credA.inode === credB.inode,
        },
        auth: {
          A: { ...authA, accountDigest: undefined },
          B: { ...authB, accountDigest: undefined },
          default: { ...authDefault, accountDigest: undefined },
          emptyProfile: { ...authEmpty, accountDigest: undefined },
          distinctAccounts:
            authA.accountDigest !== undefined &&
            authB.accountDigest !== undefined &&
            authA.accountDigest !== authB.accountDigest,
        },
      };
      evidence["namespace"] = namespace;
      save();

      expect(namespace.distinctDirectories).toBe(true);
      expect(namespace.defaultIsSeparate).toBe(true);
      for (const cred of [credA, credB]) {
        expect(cred.present).toBe(true);
        expect(cred.mode).toBe("600");
        expect(cred.isSymlink).toBe(false);
      }
      expect(namespace.credentialFile.sameInode).toBe(false);
      for (const auth of [authA, authB]) {
        expect(auth).toMatchObject({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
        });
      }
      expect(namespace.auth.distinctAccounts).toBe(true);
      // An empty CLAUDE_CONFIG_DIR has no login: credentials come from the directory, not from a
      // store shared across profiles.
      expect(authEmpty.loggedIn).toBe(false);
    });

    it(
      "runs one turn on each profile at the same time, each with its own rate_limit_event",
      async () => {
        const [runA, runB] = await Promise.all([
          timed(a, cwd, workerArgs()),
          timed(b, cwd, workerArgs()),
        ]);
        const caseA = caseOf("concurrent-A", "A", runA, origin);
        const caseB = caseOf("concurrent-B", "B", runB, origin);
        const overlapMs = Math.round(
          Math.min(runA.endMs, runB.endMs) - Math.max(runA.startMs, runB.startMs),
        );
        cases.push(caseA, caseB);
        evidence["concurrency"] = { overlapMs };
        save();

        for (const entry of [caseA, caseB]) {
          // A real limit is evidence too: it is recorded above before this assertion fails.
          expect(entry.quotaRejected, `${entry.name}: real quota rejection`).toBe(false);
          expect(entry.success, `${entry.name}: ${entry.stderrExcerpt ?? ""}`).toBe(true);
          expect(entry.apiKeySource).toBe("none");
          expect(entry.model).toMatch(/haiku/);
          expect(entry.quota.length, `${entry.name}: no rate_limit_event`).toBeGreaterThan(0);
        }
        expect(caseA.sessionId).not.toBe(caseB.sessionId);
        expect(overlapMs, "the two runs did not overlap").toBeGreaterThan(0);
      },
      RUN_TIMEOUT_MS + 30_000,
    );

    it(
      "a session persisted on A is stored under A only and cannot be resumed on B",
      async () => {
        const persisted = await timed(a, cwd, workerArgs({ persist: true }));
        const persistedCase = caseOf("session-persisted-A", "A", persisted, origin);
        cases.push(persistedCase);
        save();
        expect(persistedCase.success, persistedCase.stderrExcerpt).toBe(true);
        const sessionId = persistedCase.sessionId;
        if (sessionId === undefined) throw new Error("no session id on the persisted run");

        const underA = findSessionTranscripts(a, sessionId);
        const underB = findSessionTranscripts(b, sessionId);
        const resume = await timed(b, cwd, workerArgs({ resume: sessionId }));
        const resumeCase = caseOf("session-resume-on-B", "B", resume, origin);
        cases.push(resumeCase);
        evidence["session"] = {
          transcriptsUnderA: underA.length,
          transcriptsUnderB: underB.length,
        };
        save();

        // Remove only the transcript this test created (and its project folder if now empty).
        for (const path of underA) {
          if (
            basename(path) !== `${sessionId}.jsonl` ||
            dirname(dirname(path)) !== join(a, "projects")
          ) {
            continue;
          }
          rmSync(path, { force: true });
          if (readdirSync(dirname(path)).length === 0) rmSync(dirname(path), { recursive: true });
        }

        expect(underA).toHaveLength(1);
        expect(underB).toHaveLength(0);
        expect(resumeCase.success).toBe(false);
        // Refused before any model call: no assistant message was produced on B.
        expect(resumeCase.assistantEvents).toBe(0);
      },
      2 * RUN_TIMEOUT_MS + 30_000,
    );
  },
);
