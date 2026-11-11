// OMI-004 fault injection without quota: the real ClaudeCodeExecutor runs a fake `claude` whose
// behaviour is chosen per profile directory (`CLAUDE_CONFIG_DIR`), the real SQLite artifact
// store keeps the checkpoint, and the domain machines decide. No login, network or model.
//
// Two limit sources are exercised and kept apart: a replayed `usage-limit` fixture that the
// adapter classifies itself (`cli-reported`) and a harness-declared limit after a successful
// attempt (`injected`). Neither is evidence of real quota detection; see ADR-0031.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactStore } from "../../../../src/application/ports/artifact-store.js";
import { createLocalArtifactStore } from "../../../../src/infrastructure/artifacts/local-artifact-store.js";
import { ClaudeCodeExecutor } from "../../../../src/infrastructure/executors/claude-code/claude-code-executor.js";
import {
  applyMigrations,
  loadMigrations,
} from "../../../../src/infrastructure/persistence/sqlite/migration-runner.js";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../../src/infrastructure/persistence/sqlite/sqlite-connection.js";
import {
  createPartsRepo,
  FINAL_PARTS,
  PARTS_FILE,
  readParts,
  twoPartTask,
  workspaceStatus,
} from "../../../live/multi-profile/continuation-task.js";
import {
  runWithProfileFailover,
  type FailoverOptions,
  type ProfileSlot,
} from "../../../live/multi-profile/profile-failover.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const fixtureDir = join(repoRoot, "tests/fixtures/executors/claude-code");
const fixture = (name: string): string => readFileSync(join(fixtureDir, name), "utf8");

/** Fixed clock before the fixture's reset time (1794310800 s), so cooldowns are deterministic. */
const NOW = 1_794_300_000_000;

interface FakeProfileScenario {
  loggedIn: boolean;
  /** Literal replacements applied to `parts.txt` in the worker's cwd before replying. */
  edits: [string, string][];
  stdout: string;
  exitCode: number;
}

interface FakeInvocation {
  argv: string[];
  stdin: string;
  cwd: string;
  configDir: string | undefined;
}

// One fake executable for every profile: behaviour comes from the profile directory the adapter
// selected for this process, which is what the PoC must show works per process.
const FAKE_CLAUDE = `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const profile = process.env.CLAUDE_CONFIG_DIR ?? "";
const scenario = JSON.parse(readFileSync(join(profile, "fake-scenario.json"), "utf8"));
if (argv[0] === "--version") { process.stdout.write("2.1.322 (Claude Code)\\n"); process.exit(0); }
if (argv[0] === "auth") {
  process.stdout.write(JSON.stringify(scenario.loggedIn
    ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }
    : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }));
  process.exit(0);
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
  appendFileSync(join(profile, "invocations.jsonl"), JSON.stringify({
    argv, stdin, cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR,
  }) + "\\n");
  const file = join(process.cwd(), "parts.txt");
  for (const [from, to] of scenario.edits) {
    writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
  }
  process.stdout.write(scenario.stdout);
  process.exitCode = scenario.exitCode;
});
`;

let root: string;
let workspace: string;
let db: StateDatabase;
let store: ArtifactStore;
let executor: ClaudeCodeExecutor;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omi-004-failover-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE, { mode: 0o700 });
  // CommonJS so the fake runs without a package.json "type".
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts);
  db = openStateDatabase(join(root, "state.db"));
  applyMigrations(db, loadMigrations(join(repoRoot, "migrations")));
  store = createLocalArtifactStore(artifacts, db);
  executor = new ClaudeCodeExecutor({ executable: join(bin, "claude"), graceMs: 2_000 });
  workspace = createPartsRepo("omi-004-failover-ws-");
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function profile(id: string, accountGroup: string, scenario: FakeProfileScenario): ProfileSlot {
  const home = join(root, id);
  mkdirSync(home);
  writeFileSync(join(home, "fake-scenario.json"), JSON.stringify(scenario));
  return { id, home, accountGroup };
}

function invocations(slot: ProfileSlot): FakeInvocation[] {
  try {
    return readFileSync(join(slot.home, "invocations.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as FakeInvocation);
  } catch {
    return [];
  }
}

function options(profiles: ProfileSlot[], extra: Partial<FailoverOptions> = {}): FailoverOptions {
  return {
    executor,
    profiles,
    workspace,
    store,
    model: "claude-haiku-5-5",
    effort: "low",
    timeoutMs: 20_000,
    task: twoPartTask,
    now: () => NOW,
    ...extra,
  };
}

const PART_1: [string, string] = ["part-1: todo", "part-1: done"];
const PART_2: [string, string] = ["part-2: todo", "part-2: done"];
const limited = (edits: [string, string][]): FakeProfileScenario => ({
  loggedIn: true,
  edits,
  stdout: fixture("usage-limit.stream.jsonl"),
  exitCode: 1,
});
const succeeding = (edits: [string, string][]): FakeProfileScenario => ({
  loggedIn: true,
  edits,
  stdout: fixture("success.stream.jsonl"),
  exitCode: 0,
});

describe.skipIf(process.platform === "win32")("OMI-004 profile failover (fake CLI)", () => {
  it("a CLI-reported limit on A checkpoints, cools A down and continues on B from the checkpoint", async () => {
    const a = profile("claude-a", "account-a", limited([PART_1]));
    const b = profile("claude-b", "account-b", succeeding([PART_2]));

    const trace = await runWithProfileFailover(options([a, b]));

    expect(trace.final).toBe("succeeded-after-failover");
    expect(trace.stepStatus).toBe("succeeded");
    expect(trace.limit).toEqual({
      source: "cli-reported",
      limitType: "five_hour",
      resetsAt: 1794310800,
    });
    expect(trace.attempts.map((x) => [x.attemptId, x.profileId, x.outcome])).toEqual([
      ["attempt-1", "claude-a", "usage-limit"],
      ["attempt-2", "claude-b", "succeeded"],
    ]);
    expect(trace.attempts[0]?.quotaSignals.map((s) => s.status)).toEqual(["rejected"]);
    // Cooldown follows the reset time the CLI reported, not a guess.
    expect(trace.retryDecision).toEqual({ action: "failover", cooldownUntil: 1794310800 * 1000 });
    expect(trace.availability).toEqual([
      { profileId: "claude-a", allowed: false, reasons: ["COOLDOWN_ACTIVE"] },
      { profileId: "claude-b", allowed: true },
    ]);
    expect(trace.checkpointVerified).toBe(true);
    expect(trace.staleAttemptRefused).toBe(true);

    // A's part survived; B did only what the checkpoint said was left.
    expect(readParts(workspace)).toBe(FINAL_PARTS);
    expect(workspaceStatus(workspace)).toBe(`M ${PARTS_FILE}`);
    const [first] = invocations(a);
    const [second] = invocations(b);
    expect(invocations(a)).toHaveLength(1);
    expect(invocations(b)).toHaveLength(1);
    expect(first?.configDir).toBe(a.home);
    expect(second?.configDir).toBe(b.home);
    expect(second?.cwd).toBe(workspace);
    expect(second?.stdin).toContain("Part 1 is already done");
    expect(second?.stdin).not.toContain(twoPartTask.firstPrompt);

    // The checkpoint is a hash-pinned artifact that records the limit source and the state A left.
    const manifest = JSON.parse(
      Buffer.from(
        store.read(trace.checkpoint?.manifest ?? { path: "x", sha256: "0".repeat(64) }),
      ).toString("utf8"),
    ) as { limit: unknown; fromProfileId: string; files: { path: string; sha256: string }[] };
    expect(manifest.limit).toEqual(trace.limit);
    expect(manifest.fromProfileId).toBe("claude-a");
    expect(manifest.files.map((f) => f.path)).toEqual([PARTS_FILE]);

    expect(
      trace.transitions.filter((t) => t.machine === "step").map((t) => `${t.from}>${t.to ?? ""}`),
    ).toEqual([
      "pending>ready",
      "ready>running",
      "running>waiting_resource",
      "waiting_resource>ready",
      "ready>running",
      "running>succeeded",
    ]);
  });

  it("an injected limit is labelled injected, keeps the real outcome and spends one attempt per profile", async () => {
    const a = profile("claude-a", "account-a", succeeding([PART_1]));
    const b = profile("claude-b", "account-b", succeeding([PART_2]));

    const trace = await runWithProfileFailover(
      options([a, b], { injectLimitAfterFirstAttempt: true }),
    );

    expect(trace.final).toBe("succeeded-after-failover");
    expect(trace.limit).toEqual({ source: "injected" });
    // The adapter's own result is unchanged: injection never fakes a usage-limit outcome.
    expect(trace.attempts[0]?.outcome).toBe("succeeded");
    expect(trace.attempts[0]?.quotaSignals.map((s) => s.status)).toEqual(["allowed"]);
    // No reset time is known, so the cooldown is the bounded backoff (60 s base, jitter 0.5).
    expect(trace.retryDecision).toEqual({ action: "failover", cooldownUntil: NOW + 45_000 });
    expect(readParts(workspace)).toBe(FINAL_PARTS);
  });

  it("profiles of the same account cool down together: no candidate means waiting_resource", async () => {
    const a = profile("claude-a", "shared-account", limited([PART_1]));
    const b = profile("claude-b", "shared-account", succeeding([PART_2]));

    const trace = await runWithProfileFailover(options([a, b]));

    expect(trace.final).toBe("waiting-resource");
    expect(trace.stepStatus).toBe("waiting_resource");
    expect(trace.availability.every((entry) => !entry.allowed)).toBe(true);
    expect(invocations(b)).toHaveLength(0);
    // The checkpoint exists, so a later dispatch can continue from it.
    expect(trace.checkpoint?.nextAction).toContain("part-2");
  });

  it("a logged-out alternative is not a candidate", async () => {
    const a = profile("claude-a", "account-a", limited([PART_1]));
    const b = profile("claude-b", "account-b", { ...succeeding([PART_2]), loggedIn: false });

    const trace = await runWithProfileFailover(options([a, b]));

    expect(trace.probes.map((p) => p.status)).toEqual(["ready", "login-required"]);
    expect(trace.final).toBe("waiting-resource");
    expect(trace.availability[1]).toEqual({
      profileId: "claude-b",
      allowed: false,
      reasons: ["LOGIN_REQUIRED"],
    });
    expect(invocations(b)).toHaveLength(0);
  });

  it("a login failure is not a limit: the step stops without failover", async () => {
    const a = profile("claude-a", "account-a", {
      loggedIn: true,
      edits: [],
      stdout: fixture("auth-failure.stream.jsonl"),
      exitCode: 1,
    });
    const b = profile("claude-b", "account-b", succeeding([PART_1, PART_2]));

    const trace = await runWithProfileFailover(
      options([a, b], { injectLimitAfterFirstAttempt: true }),
    );

    expect(trace.attempts.map((x) => x.outcome)).toEqual(["auth-required"]);
    expect(trace.limit).toBeUndefined();
    expect(trace.retryDecision).toEqual({ action: "stop", reason: "LOGIN_REQUIRED" });
    expect(trace.final).toBe("stopped");
    expect(trace.stepStatus).toBe("failed");
    expect(invocations(b)).toHaveLength(0);
  });

  it("a workspace changed after the checkpoint is refused before any attempt on B", async () => {
    const a = profile("claude-a", "account-a", limited([PART_1]));
    const b = profile("claude-b", "account-b", succeeding([PART_2]));

    const trace = await runWithProfileFailover(
      options([a, b], {
        afterCheckpoint: () => {
          appendFileSync(join(workspace, PARTS_FILE), "tampered\n");
        },
      }),
    );

    expect(trace.checkpointVerified).toBe(false);
    expect(trace.final).toBe("checkpoint-invalid");
    expect(trace.transitions.at(-1)).toMatchObject({
      machine: "step",
      event: "start",
      refused: "CONTEXT_NOT_SAVED",
    });
    expect(invocations(b)).toHaveLength(0);
  });

  it("no limit, no failover: a complete first attempt never touches B", async () => {
    const a = profile("claude-a", "account-a", succeeding([PART_1, PART_2]));
    const b = profile("claude-b", "account-b", succeeding([]));

    const trace = await runWithProfileFailover(options([a, b]));

    expect(trace.final).toBe("succeeded-without-limit");
    expect(trace.limit).toBeUndefined();
    expect(invocations(b)).toHaveLength(0);
  });
});
