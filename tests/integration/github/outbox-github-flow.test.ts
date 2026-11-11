import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GithubOperation } from "../../../src/application/contracts/github-operation.ts";
import {
  flushOutbox,
  type FlushOutboxDeps,
} from "../../../src/application/use-cases/sync/flush-outbox.ts";
import type { ArtifactStore } from "../../../src/application/ports/artifact-store.ts";
import { operationMarker } from "../../../src/domain/delivery/operation-marker.ts";
import { createLocalArtifactStore } from "../../../src/infrastructure/artifacts/local-artifact-store.ts";
import { createGithubRemote } from "../../../src/infrastructure/github/github-remote.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteOutboxStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-outbox-store.ts";
import { FakeGithub, type FaultEffect } from "../../contract/github/fake-github.ts";

const T0 = Date.parse("2026-11-11T08:00:00.000Z");
const MINUTE = 60_000;
const GRACE_MS = 2 * MINUTE;

const COMMENT: GithubOperation = {
  type: "issue.comment",
  repo: "acme/app",
  issueNumber: 7,
  body: "Task finished",
};
const ISSUE: GithubOperation = {
  type: "issue.create",
  repo: "acme/app",
  title: "Follow-up",
  body: "Details",
};
const PULL: GithubOperation = {
  type: "pull_request.create",
  repo: "acme/app",
  head: "task/omi-24",
  base: "develop",
  title: "OMI-24",
  body: "Issue: #28",
};

interface Row {
  state: string;
  attempt_count: number;
  remote_identity: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
}

let dir: string;
let db: StateDatabase;
let github: FakeGithub;
let clock: { ms: number };
let payloads: number;
let deps: FlushOutboxDeps;
/** The use cases only read payloads; the test runtime writes them. */
let artifactStore: ArtifactStore;

/** Everything a runtime restart rebuilds from disk: connection, stores and adapters. */
function wire(): void {
  db = openStateDatabase(join(dir, "state.db"));
  applyMigrations(db, loadMigrations(resolve(import.meta.dirname, "../../../migrations")));
  artifactStore = createLocalArtifactStore(join(dir, "artifacts"), db);
  const client = createGithubRestClient({
    transport: github,
    sleep: (ms) => {
      clock.ms += ms;
      return Promise.resolve();
    },
    now: () => clock.ms,
    random: () => 0,
    policy: { maxInlineWaitMs: 60_000 },
  });
  let events = 0;
  deps = {
    outbox: createSqliteOutboxStore(db),
    artifacts: artifactStore,
    github: createGithubRemote(client),
    now: () => clock.ms,
    newEventId: () => `event-${String(Date.now())}-${String((events += 1))}`,
    reconcileGraceMs: GRACE_MS,
    retryBudget: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
    jitter: () => 0,
    batchSize: 50,
  };
}

/** What the runtime does when a use case asks for an external action: pin the payload, queue it. */
function enqueue(operationKey: string, operation: GithubOperation): void {
  payloads += 1;
  const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, operation }));
  const reference = artifactStore.write({
    id: `payload-${String(payloads)}`,
    path: `outbox/payload-${String(payloads)}.json`,
    bytes,
    classification: "outbox-payload",
    createdAt: new Date(clock.ms).toISOString(),
  });
  db.prepare(
    `INSERT INTO outbox (operation_key, kind, subject, payload_ref, payload_hash, state, created_at, updated_at)
     VALUES (?, ?, 'run-1', ?, ?, 'pending', ?, ?)`,
  ).run(
    operationKey,
    operation.type,
    reference.path,
    reference.sha256,
    new Date(clock.ms).toISOString(),
    new Date(clock.ms).toISOString(),
  );
}

function row(operationKey: string): Row {
  return db
    .prepare(
      "SELECT state, attempt_count, remote_identity, next_attempt_at, last_error FROM outbox WHERE operation_key = ?",
    )
    .get(operationKey) as Row;
}

const posts = () => github.requests.filter((request) => request.method === "POST");
const resources = () => github.comments.length + github.issues.length + github.pulls.length;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-outbox-flow-"));
  mkdirSync(join(dir, "artifacts"));
  clock = { ms: T0 };
  payloads = 0;
  github = new FakeGithub({ now: () => clock.ms });
  wire();
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("outbox → GitHub: one operation marker, one remote effect", () => {
  it("sends the operation with its marker and records the remote identity and audit trail", async () => {
    enqueue("comment:run-1:done", COMMENT);

    const report = await flushOutbox(deps);

    expect(report.attempts).toHaveLength(1);
    expect(github.comments.map((c) => c.body)).toEqual([
      `Task finished\n\n${operationMarker("comment:run-1:done")}`,
    ]);
    expect(row("comment:run-1:done")).toMatchObject({
      state: "succeeded",
      attempt_count: 1,
      remote_identity: `issue_comment:acme/app:${String(github.comments[0]?.id)}`,
      last_error: null,
    });
    const audit = db.prepare("SELECT kind, correlation_id FROM events ORDER BY sequence").all() as {
      kind: string;
      correlation_id: string;
    }[];
    expect(audit).toEqual([
      { kind: "outbox.begin_attempt", correlation_id: "comment:run-1:done" },
      { kind: "outbox.attempt_succeeded", correlation_id: "comment:run-1:done" },
    ]);
  });

  it("does not repeat a succeeded operation on later passes or after a restart", async () => {
    enqueue("comment:run-1:done", COMMENT);
    await flushOutbox(deps);
    await flushOutbox(deps);
    db.close();
    wire();
    await flushOutbox(deps);
    expect(posts()).toHaveLength(1);
    expect(resources()).toBe(1);
  });

  describe("timeout after success", () => {
    const lostResponses: [string, FaultEffect][] = [
      ["the response times out", { type: "apply_then_fail", failure: "timeout" }],
      ["the connection breaks", { type: "apply_then_fail", failure: "connection" }],
      ["a gateway answers 502", { type: "apply_then_status", status: 502 }],
    ];
    const operations: [string, string, GithubOperation][] = [
      ["comment", "comment:run-1:done", COMMENT],
      ["issue", "issue:task-28", ISSUE],
      ["pull request", "create-pr:acme/app:task-28:task/omi-24:develop", PULL],
    ];

    for (const [what, key, operation] of operations) {
      for (const [when, effect] of lostResponses) {
        it(`${what}: when ${when} after GitHub applied it, the sync finds the marker and does not create it again`, async () => {
          enqueue(key, operation);
          github.inject({ method: "POST", effect });

          const first = await flushOutbox(deps);
          expect(first.stopped).toBe("OUTCOME_UNKNOWN");
          expect(row(key).state).toBe("outcome_unknown");
          expect(resources()).toBe(1);

          clock.ms += GRACE_MS;
          const second = await flushOutbox(deps);

          expect(second.reconcile.entries).toMatchObject([
            { operationKey: key, outcome: "succeeded" },
          ]);
          expect(second.attempts).toEqual([]);
          expect(row(key).state).toBe("succeeded");
          expect(row(key).remote_identity).toMatch(/^(issue_comment|issue|pull_request):acme\/app/);
          expect(resources()).toBe(1);
          expect(posts()).toHaveLength(1);
        });
      }
    }

    it("finds the marker even before the grace period, because found is conclusive", async () => {
      enqueue("comment:run-1:done", COMMENT);
      github.inject({ method: "POST", effect: { type: "apply_then_fail", failure: "timeout" } });
      await flushOutbox(deps);
      clock.ms += 1_000;
      await flushOutbox(deps);
      expect(row("comment:run-1:done").state).toBe("succeeded");
      expect(posts()).toHaveLength(1);
    });

    it("a marker found for the same key on a different issue does not complete the operation", async () => {
      enqueue("comment:run-1:done", COMMENT);
      github.inject({ method: "POST", effect: { type: "fail", failure: "timeout" } });
      await flushOutbox(deps);
      github.addComment("acme/app", 8, `x ${operationMarker("comment:run-1:done")}`);

      clock.ms += GRACE_MS;
      await flushOutbox(deps);

      // Issue 7 had no such comment, so the operation was sent and landed on issue 7 exactly once.
      expect(github.comments.filter((c) => c.issueNumber === 7)).toHaveLength(1);
      expect(row("comment:run-1:done").state).toBe("succeeded");
    });
  });

  describe("timeout before the effect", () => {
    it("reads the remote, sees nothing after the grace period, then sends — one effect in the end", async () => {
      enqueue("comment:run-1:done", COMMENT);
      github.inject({ method: "POST", effect: { type: "fail", failure: "timeout" } });
      await flushOutbox(deps);
      expect(resources()).toBe(0);

      clock.ms += GRACE_MS;
      await flushOutbox(deps);

      expect(resources()).toBe(1);
      expect(posts()).toHaveLength(2);
      expect(row("comment:run-1:done")).toMatchObject({ state: "succeeded", attempt_count: 2 });
    });

    it("does not send again inside the grace period: the first request may still be running", async () => {
      enqueue("comment:run-1:done", COMMENT);
      github.inject({ method: "POST", effect: { type: "fail", failure: "timeout" } });
      await flushOutbox(deps);

      clock.ms += GRACE_MS - 1;
      const second = await flushOutbox(deps);

      expect(second.reconcile.entries).toMatchObject([{ outcome: "waiting" }]);
      expect(posts()).toHaveLength(1);
      expect(row("comment:run-1:done").state).toBe("outcome_unknown");
    });
  });

  describe("GitHub offline", () => {
    it("keeps local state while offline and, once online, a later sync creates each effect exactly once", async () => {
      enqueue("comment:run-1:a", COMMENT);
      enqueue("comment:run-1:b", { ...COMMENT, body: "Second" });
      github.offline = true;

      // Offline pass 1: the send cannot get through; it is recorded, not lost, and not guessed.
      const first = await flushOutbox(deps);
      expect(first.stopped).toBe("OUTCOME_UNKNOWN");
      expect(row("comment:run-1:a")).toMatchObject({
        state: "outcome_unknown",
        last_error: "CONNECTION_FAILED",
      });
      expect(row("comment:run-1:b").state).toBe("pending");

      // The runtime restarts while GitHub is still unreachable; state survives on disk.
      db.close();
      wire();
      clock.ms += GRACE_MS;
      const requestsBefore = github.requests.length;
      const second = await flushOutbox(deps);
      expect(second.stopped).toBe("GITHUB_UNAVAILABLE");
      expect(second.attempts).toEqual([]);
      expect(row("comment:run-1:a").state).toBe("outcome_unknown");
      expect(row("comment:run-1:b").state).toBe("pending");
      // Offline, the pass only tried to read: nothing was written.
      expect(github.requests.slice(requestsBefore).every((r) => r.method === "GET")).toBe(true);
      expect(resources()).toBe(0);

      // GitHub is back.
      github.offline = false;
      clock.ms += GRACE_MS;
      await flushOutbox(deps);
      await flushOutbox(deps);

      expect(github.comments.map((c) => c.body.split("\n")[0]).sort()).toEqual([
        "Second",
        "Task finished",
      ]);
      expect(row("comment:run-1:a").state).toBe("succeeded");
      expect(row("comment:run-1:b").state).toBe("succeeded");
    });

    it("an offline period after a lost success still ends with one effect", async () => {
      enqueue("comment:run-1:a", COMMENT);
      github.inject({ method: "POST", effect: { type: "apply_then_fail", failure: "timeout" } });
      await flushOutbox(deps);
      expect(resources()).toBe(1);

      github.offline = true;
      clock.ms += GRACE_MS;
      expect((await flushOutbox(deps)).stopped).toBe("GITHUB_UNAVAILABLE");

      github.offline = false;
      await flushOutbox(deps);
      expect(resources()).toBe(1);
      expect(posts()).toHaveLength(1);
      expect(row("comment:run-1:a").state).toBe("succeeded");
    });
  });

  describe("crash during the call", () => {
    it("a row left in_flight is searched after restart, not sent again", async () => {
      enqueue("comment:run-1:a", COMMENT);
      // The process wrote in_flight, GitHub applied the request, then the process died.
      db.prepare(
        "UPDATE outbox SET state = 'in_flight', attempt_count = 1 WHERE operation_key = ?",
      ).run("comment:run-1:a");
      github.addComment("acme/app", 7, `Task finished\n\n${operationMarker("comment:run-1:a")}`);
      db.close();
      wire();

      const report = await flushOutbox(deps);

      expect(report.reconcile.entries).toMatchObject([{ outcome: "succeeded" }]);
      expect(posts()).toEqual([]);
      expect(resources()).toBe(1);
    });

    it("a row left in_flight whose request never arrived is sent once, after the grace period", async () => {
      enqueue("comment:run-1:a", COMMENT);
      db.prepare(
        "UPDATE outbox SET state = 'in_flight', attempt_count = 1 WHERE operation_key = ?",
      ).run("comment:run-1:a");
      db.close();
      wire();

      const early = await flushOutbox(deps);
      expect(early.reconcile.entries).toMatchObject([{ outcome: "waiting" }]);
      expect(posts()).toEqual([]);

      clock.ms += GRACE_MS;
      await flushOutbox(deps);
      expect(posts()).toHaveLength(1);
      expect(resources()).toBe(1);
      expect(row("comment:run-1:a")).toMatchObject({ state: "succeeded", attempt_count: 2 });
    });
  });

  describe("long listings", () => {
    it("finds the marker deep inside a listing that spans several pages", async () => {
      enqueue("comment:run-1:a", COMMENT);
      db.prepare("UPDATE outbox SET state = 'outcome_unknown', attempt_count = 1").run();
      for (let i = 0; i < 230; i += 1) github.addComment("acme/app", 7, `noise ${String(i)}`);
      github.addComment("acme/app", 7, operationMarker("comment:run-1:a"));
      for (let i = 0; i < 40; i += 1) github.addComment("acme/app", 7, `noise ${String(i)}`);
      const before = github.requests.length;

      await flushOutbox(deps);

      expect(github.requests.length - before).toBe(3);
      expect(row("comment:run-1:a").state).toBe("succeeded");
      expect(posts()).toEqual([]);
    });
  });

  describe("rate limit and refusals", () => {
    it("persists Retry-After across passes: nothing is sent before it, one send after it", async () => {
      enqueue("comment:run-1:a", COMMENT);
      github.inject({
        method: "POST",
        effect: { type: "status", status: 429, headers: { "retry-after": "300" } },
      });

      const first = await flushOutbox(deps);
      expect(first.stopped).toBe("RATE_LIMITED");
      expect(row("comment:run-1:a")).toMatchObject({
        state: "pending",
        next_attempt_at: new Date(T0 + 300_000).toISOString(),
        last_error: "RATE_LIMITED",
      });

      clock.ms = T0 + 300_000 - 1;
      db.close();
      wire();
      const requestsBefore = github.requests.length;
      await flushOutbox(deps);
      expect(github.requests.length).toBe(requestsBefore);

      clock.ms = T0 + 300_000;
      await flushOutbox(deps);
      expect(resources()).toBe(1);
      expect(row("comment:run-1:a")).toMatchObject({
        state: "succeeded",
        next_attempt_at: null,
        last_error: null,
      });
      // A refusal means nothing was applied, so no read-back was needed before the retry.
      expect(github.requests.filter((r) => r.method === "GET")).toEqual([]);
    });

    it("marks a permanently refused operation failed and never sends it again", async () => {
      enqueue("pr:task-28", PULL);
      github.inject({ method: "POST", effect: { type: "status", status: 422 } });
      await flushOutbox(deps);
      expect(row("pr:task-28")).toMatchObject({ state: "failed", last_error: "HTTP_422" });

      clock.ms += GRACE_MS;
      await flushOutbox(deps);
      expect(posts()).toHaveLength(1);
    });

    it("gives up once the attempt budget is spent, with every attempt counted", async () => {
      enqueue("comment:run-1:a", COMMENT);
      github.inject({
        method: "POST",
        times: 99,
        effect: { type: "status", status: 429, headers: { "retry-after": "120" } },
      });
      for (let pass = 0; pass < 5; pass += 1) {
        await flushOutbox(deps);
        clock.ms += 120_000;
      }
      expect(row("comment:run-1:a")).toMatchObject({
        state: "failed",
        attempt_count: 3,
        last_error: "RATE_LIMITED",
      });
      expect(posts()).toHaveLength(3);
      expect(resources()).toBe(0);
    });
  });

  it("only ever stores states the database allows: every audit event matches the stored row", async () => {
    enqueue("comment:run-1:a", COMMENT);
    github.inject({ method: "POST", effect: { type: "apply_then_fail", failure: "timeout" } });
    await flushOutbox(deps);
    clock.ms += GRACE_MS;
    await flushOutbox(deps);
    const audit = db.prepare("SELECT kind, payload FROM events ORDER BY sequence").all() as {
      kind: string;
      payload: string;
    }[];
    expect(audit.map((event) => event.kind)).toEqual([
      "outbox.begin_attempt",
      "outbox.attempt_outcome_unknown",
      "outbox.reconciled_found",
    ]);
    const last = JSON.parse(audit[2]?.payload ?? "{}") as { to: string };
    expect(last.to).toBe(row("comment:run-1:a").state);
  });
});
