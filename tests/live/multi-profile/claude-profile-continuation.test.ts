// OMI-004 — live: a step started on Claude profile A continues on profile B from a checkpoint,
// through the production ClaudeCodeExecutor (ADR-0023 open decision 5) and the domain profile,
// step and retry machines.
//
// Opt-in, never part of `npm run check` or CI. Both variables unset: the suite is skipped.
//   OMI_LIVE_CLAUDE_PROFILE_A=<dir> OMI_LIVE_CLAUDE_PROFILE_B=<dir> \
//     vitest run tests/live/multi-profile/claude-profile-continuation.test.ts
//
// The limit is INJECTED after A's successful first attempt (no quota is spent to reach a real
// limit) unless A's run is really limited, in which case the trace says `cli-reported`. The
// evidence keeps the two apart. Set OMI_LIVE_INJECT_LIMIT=0 to require a real limit.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalArtifactStore } from "../../../src/infrastructure/artifacts/local-artifact-store.js";
import { buildClaudeCodeEnvironment } from "../../../src/infrastructure/executors/claude-code/claude-code-environment.js";
import { ClaudeCodeExecutor } from "../../../src/infrastructure/executors/claude-code/claude-code-executor.js";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.js";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.js";
import { redactText } from "../claude-code/claude-cli-process.js";
import { readClaudeAuth } from "./claude-profile-namespace.js";
import {
  createPartsRepo,
  FINAL_PARTS,
  PARTS_FILE,
  readParts,
  twoPartTask,
  workspaceStatus,
} from "./continuation-task.js";
import { runWithProfileFailover, type FailoverTrace } from "./profile-failover.js";

const rawA = process.env["OMI_LIVE_CLAUDE_PROFILE_A"];
const rawB = process.env["OMI_LIVE_CLAUDE_PROFILE_B"];
const MODEL = process.env["OMI_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5";
const INJECT = process.env["OMI_LIVE_INJECT_LIMIT"] !== "0";
const repoRoot = resolve(import.meta.dirname, "../../..");
const evidenceDir = join(repoRoot, ".tmp/live");

function profileDir(raw: string | undefined, name: string): string {
  if (raw === undefined || raw.trim() === "") throw new Error(`${name} must name a profile`);
  const dir = resolve(raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`${name} does not point to a directory`);
  }
  return dir;
}

describe.skipIf(rawA === undefined && rawB === undefined)(
  "OMI-004 Claude Code continuation after a profile switch (live)",
  () => {
    let root: string;
    let workspace: string;
    let db: StateDatabase;
    const evidence: Record<string, unknown> = {
      task: "OMI-004",
      suite: "claude-profile-continuation",
      startedAt: new Date().toISOString(),
      model: MODEL,
      injectLimit: INJECT,
      profiles: {
        A: rawA === undefined ? undefined : basename(rawA),
        B: rawB === undefined ? undefined : basename(rawB),
      },
    };

    function save(): void {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        join(evidenceDir, "omi-004-claude-continuation-evidence.json"),
        redactText(JSON.stringify(evidence, null, 2)) + "\n",
        { mode: 0o600 },
      );
    }

    beforeAll(() => {
      if (/fable/i.test(MODEL)) throw new Error("Fable models must not be used for OMI-004");
      root = mkdtempSync(join(tmpdir(), "omi-004-continuation-state-"));
      mkdirSync(join(root, "artifacts"));
      db = openStateDatabase(join(root, "state.db"));
      applyMigrations(db, loadMigrations(join(repoRoot, "migrations")));
      workspace = createPartsRepo();
    });

    afterAll(() => {
      evidence["finishedAt"] = new Date().toISOString();
      save();
      if (db.open) db.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    });

    it("continues the step on B from the checkpoint after a limit on A", async () => {
      const a = profileDir(rawA, "OMI_LIVE_CLAUDE_PROFILE_A");
      const b = profileDir(rawB, "OMI_LIVE_CLAUDE_PROFILE_B");
      // Account groups come from the login itself (compared in memory, never recorded): two
      // profiles of one account would share quota and cool down together.
      const digestA = readClaudeAuth(buildClaudeCodeEnvironment(process.env, a)).accountDigest;
      const digestB = readClaudeAuth(buildClaudeCodeEnvironment(process.env, b)).accountDigest;
      const sameAccount = digestA !== undefined && digestA === digestB;
      evidence["sameAccount"] = sameAccount;

      let trace: FailoverTrace | undefined;
      try {
        trace = await runWithProfileFailover({
          executor: new ClaudeCodeExecutor(),
          profiles: [
            { id: "claude-A", home: a, accountGroup: "account-A" },
            { id: "claude-B", home: b, accountGroup: sameAccount ? "account-A" : "account-B" },
          ],
          workspace,
          store: createLocalArtifactStore(join(root, "artifacts"), db),
          model: MODEL,
          effort: "low",
          timeoutMs: 180_000,
          task: twoPartTask,
          injectLimitAfterFirstAttempt: INJECT,
          now: () => Date.now(),
        });
      } finally {
        evidence["trace"] = trace;
        evidence["partsAfter"] = readParts(workspace);
        evidence["gitStatusAfter"] = workspaceStatus(workspace);
        save();
      }

      expect(trace.probes.map((p) => p.status)).toEqual(["ready", "ready"]);
      expect(trace.final).toBe("succeeded-after-failover");
      expect(trace.attempts.map((x) => x.profileId)).toEqual(["claude-A", "claude-B"]);
      expect(INJECT ? ["injected", "cli-reported"] : ["cli-reported"]).toContain(
        trace.limit?.source,
      );
      for (const attempt of trace.attempts) {
        expect(attempt.authMode).toBe("subscription");
        expect(attempt.modelActual).toMatch(/haiku/);
      }
      expect(trace.checkpointVerified).toBe(true);
      expect(trace.staleAttemptRefused).toBe(true);
      expect(readParts(workspace)).toBe(FINAL_PARTS);
      expect(workspaceStatus(workspace)).toBe(`M ${PARTS_FILE}`);
    }, 420_000);
  },
);
