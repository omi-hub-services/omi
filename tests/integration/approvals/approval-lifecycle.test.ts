import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordApprovalInput } from "../../../src/application/contracts/approval.ts";
import { commandSchema } from "../../../src/application/contracts/command.ts";
import { stepResultSchema } from "../../../src/application/contracts/result.ts";
import type { VerifiedApprovalDecision } from "../../../src/application/ports/approval-decision-source.ts";
import { requestApproval } from "../../../src/application/use-cases/approvals/request-approval.ts";
import {
  recordApproval,
  type RecordApprovalDependencies,
} from "../../../src/application/use-cases/approvals/record-approval.ts";
import { createRuntimeIpcServer } from "../../../src/bootstrap/container.ts";
import {
  approvalSubjectHash,
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalSubject,
} from "../../../src/domain/approvals/approval.ts";
import { checkExecutionApprovals } from "../../../src/application/services/check-execution-approvals.ts";
import { createGitHubApprovalDecisionSource } from "../../../src/infrastructure/github/github-approval-decision-source.ts";
import { createInteractiveApprovalConfirmation } from "../../../src/infrastructure/processes/interactive-approval-decision.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { createSqliteApprovalStore } from "../../../src/infrastructure/persistence/sqlite/sqlite-approval-store.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { createSqliteStateUnitOfWork } from "../../../src/infrastructure/persistence/sqlite/sqlite-state-unit-of-work.ts";
import { runCli } from "../../../src/interfaces/cli/commands/create-program.ts";
import { sendCommand } from "../../../src/interfaces/ipc/ipc-client.ts";
import type { IpcServer } from "../../../src/interfaces/ipc/ipc-server.ts";

const migrations = loadMigrations(resolve(import.meta.dirname, "../../../migrations"));
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const subjects = new Map<string, ApprovalSubject>();
let dir: string;
let db: StateDatabase;
let deps: RecordApprovalDependencies;
let now: number;
let ids: number;
let cliConfirmed: boolean;
let comment: unknown;
let server: IpcServer | undefined;
const readComment = vi.fn<(endpoint: string) => Promise<unknown>>();

function evidence(request: ApprovalRequest, input: RecordApprovalInput): VerifiedApprovalDecision {
  return {
    approvalId: request.id,
    subjectHash: request.subjectHash,
    version: request.version,
    decision: input.decision,
    actor: "po",
    source: "po-cli",
    evidenceRef: "terminal-confirmation",
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-approval-"));
  db = openStateDatabase(join(dir, "state.db"));
  applyMigrations(db, migrations);
  now = 1000;
  ids = 0;
  cliConfirmed = true;
  subjects.clear();
  subjects.set("business", { kind: "business", baselineHash: H1, scopeIds: ["task"] });
  subjects.set("cost", { kind: "cost", estimateHash: H1, scopeIds: ["task"] });
  subjects.set("release", { kind: "release", pullRequestId: "pr-1", headSha: "a".repeat(40) });
  subjects.set("deploy", {
    kind: "deploy",
    artifactDigest: `sha256:${H1}`,
    environment: "production",
  });
  readComment.mockReset();
  readComment.mockImplementation(() => Promise.resolve(comment));
  deps = {
    store: createSqliteApprovalStore(db),
    unitOfWork: createSqliteStateUnitOfWork(db),
    subjects: { read: (subjectId) => subjects.get(subjectId) },
    now: () => now,
    nextId: () => `id-${String(++ids)}`,
    allowedGitHubActors: ["po"],
    source: createGitHubApprovalDecisionSource({
      repository: "acme/app",
      readComment,
      confirmCli: (request, input) =>
        Promise.resolve(cliConfirmed ? evidence(request, input) : undefined),
    }),
  };
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function requested(kind: ApprovalKind = "business", expiresAt?: number): ApprovalRequest {
  const result = requestApproval(deps, {
    schemaVersion: 1,
    subjectId: kind,
    kind,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  if (!result.ok) throw new Error(result.reason);
  return result.request;
}
function decision(
  request: ApprovalRequest,
  overrides: Partial<RecordApprovalInput> = {},
): RecordApprovalInput {
  return {
    schemaVersion: 1,
    approvalId: request.id,
    expectedVersion: request.version,
    decision: "approved",
    pathway: "cli",
    ...overrides,
  };
}
function githubComment(
  request: ApprovalRequest,
  overrides: Record<string, unknown> = {},
  actor = "po",
  type = "User",
  metadata: { created_at?: unknown; updated_at?: unknown } = {},
): void {
  comment = {
    user: { login: actor, type },
    created_at: "2026-11-11T01:00:00Z",
    updated_at: "2026-11-11T01:00:00Z",
    ...metadata,
    body: JSON.stringify({
      schemaVersion: 1,
      approvalId: request.id,
      subjectHash: request.subjectHash,
      version: request.version,
      decision: "approved",
      ...overrides,
    }),
  };
}
function counts() {
  return {
    approvals: db.prepare("SELECT count(*) AS n FROM approvals").get(),
    events: db.prepare("SELECT count(*) AS n FROM events").get(),
  };
}

// AC-1: pinned subjects, optimistic versioning, approve/reject/stale and durable audit.
describe("versioned approval lifecycle with SQLite", () => {
  it.each<ApprovalKind>(["business", "cost", "release", "deploy"])(
    "pins and approves a %s request with actor/source/hash",
    async (kind) => {
      const request = requested(kind);
      expect(request).toMatchObject({
        status: "pending",
        version: 0,
        subjectHash: approvalSubjectHash(request.subject),
      });
      expect(await recordApproval(deps, decision(request))).toMatchObject({
        ok: true,
        request: {
          version: 1,
          status: "approved",
          decision: { actor: "po", source: "po-cli", decidedAt: now },
        },
      });
      expect(
        db.prepare("SELECT actor, channel, decision, subject_hash, version FROM approvals").get(),
      ).toEqual({
        actor: "po",
        channel: "po-cli",
        decision: "approved",
        subject_hash: request.subjectHash,
        version: 1,
      });
      expect(db.prepare("SELECT kind FROM events ORDER BY sequence").all()).toEqual([
        { kind: "approval.requested" },
        { kind: "approval.approved" },
      ]);
      db.close();
      db = openStateDatabase(join(dir, "state.db"));
      expect(createSqliteApprovalStore(db).get(request.id)).toMatchObject({
        status: "approved",
        version: 1,
        subject: request.subject,
        decision: { evidenceRef: "terminal-confirmation" },
      });
    },
  );

  it("rejects with a reason and cannot flip a rejection or an approval", async () => {
    const request = requested();
    expect(await recordApproval(deps, decision(request, { decision: "rejected" }))).toEqual({
      ok: false,
      reason: "REJECTION_REASON_MISSING",
    });
    expect(
      await recordApproval(
        deps,
        decision(request, { decision: "rejected", reason: "out of scope" }),
      ),
    ).toMatchObject({
      ok: true,
      request: { status: "rejected", decision: { reason: "out of scope" } },
    });
    expect(await recordApproval(deps, decision({ ...request, version: 1 }))).toEqual({
      ok: false,
      reason: "TRANSITION_NOT_ALLOWED",
    });
    const second = requested();
    await recordApproval(deps, decision(second));
    expect(
      await recordApproval(
        deps,
        decision({ ...second, version: 1 }, { decision: "rejected", reason: "flip" }),
      ),
    ).toEqual({ ok: false, reason: "TRANSITION_NOT_ALLOWED" });
  });

  it.each(["pending", "approved"] as const)(
    "makes a %s decision stale when its subject changes",
    async (status) => {
      let request = requested();
      if (status === "approved") {
        await recordApproval(deps, decision(request));
        request = { ...request, version: 1 };
      }
      subjects.set("business", { kind: "business", baselineHash: H2, scopeIds: ["task"] });
      expect(await recordApproval(deps, decision(request))).toEqual({
        ok: false,
        reason: "STALE_REVISION",
      });
      expect(deps.store.get(request.id)).toMatchObject({
        status: "invalidated",
        version: request.version + 1,
      });
      expect(
        await recordApproval(deps, decision({ ...request, version: request.version + 1 })),
      ).toEqual({ ok: false, reason: "TRANSITION_NOT_ALLOWED" });
      // The next decision is a distinct request for the new revision, never an overwrite of history.
      const next = requested();
      expect(next.subjectHash).toBe(H2);
      expect(next.id).not.toBe(request.id);
      expect(await recordApproval(deps, decision(next))).toMatchObject({ ok: true });
    },
  );

  it.each(["approved", "rejected", "expired", "invalidated"] as const)(
    "refuses new decisions on %s requests without prompting or reading GitHub",
    async (status) => {
      const request = requested("business", now + 1);
      const initial = await recordApproval(
        deps,
        decision(
          request,
          status === "rejected" ? { decision: "rejected", reason: "declined" } : {},
        ),
      );
      if (!initial.ok) throw new Error(initial.reason);
      let current = initial.request;
      if (status === "expired" || status === "invalidated") {
        if (status === "expired") now += 1;
        else subjects.set("business", { kind: "business", baselineHash: H2, scopeIds: ["task"] });
        await recordApproval(deps, decision(current));
        const stored = deps.store.get(request.id);
        if (stored === undefined) throw new Error("missing request");
        current = stored;
      }
      expect(current.status).toBe(status);
      const verify = vi.spyOn(deps.source, "verify");
      const before = counts();
      for (const pathway of ["cli", "github"] as const) {
        expect(
          await recordApproval(deps, decision(current, { pathway, evidenceRef: "42" })),
        ).toEqual({ ok: false, reason: "TRANSITION_NOT_ALLOWED" });
      }
      expect(verify).not.toHaveBeenCalled();
      expect(readComment).not.toHaveBeenCalled();
      expect(counts()).toEqual(before);
      expect(deps.store.get(request.id)).toEqual(current);
    },
  );

  it.each(["stale", "expired"] as const)(
    "invalidates an existing %s approval without consulting the decision source",
    async (condition) => {
      const request = requested("business", now + 1);
      const initial = await recordApproval(deps, decision(request));
      if (!initial.ok) throw new Error(initial.reason);
      const verify = vi.spyOn(deps.source, "verify");
      if (condition === "expired") now += 1;
      else subjects.set("business", { kind: "business", baselineHash: H2, scopeIds: ["task"] });
      expect(await recordApproval(deps, decision(initial.request))).toEqual({
        ok: false,
        reason: condition === "expired" ? "EXPIRED" : "STALE_REVISION",
      });
      expect(deps.store.get(request.id)?.status).toBe(
        condition === "expired" ? "expired" : "invalidated",
      );
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it("re-reads the subject after asynchronous authentication and detects changed scope", async () => {
    const request = requested();
    deps = {
      ...deps,
      source: {
        verify(req, input) {
          subjects.set("business", {
            kind: "business",
            baselineHash: H1,
            scopeIds: ["task", "extra"],
          });
          return Promise.resolve(evidence(req, input));
        },
      },
    };
    expect(await recordApproval(deps, decision(request))).toEqual({
      ok: false,
      reason: "STALE_REVISION",
    });
    expect(deps.store.get(request.id)?.status).toBe("invalidated");
  });

  it("expires exactly at expiresAt and refuses requests already expired", async () => {
    expect(
      requestApproval(deps, {
        schemaVersion: 1,
        subjectId: "business",
        kind: "business",
        expiresAt: now,
      }),
    ).toEqual({ ok: false, reason: "EXPIRED" });
    const request = requested("business", now + 1);
    now += 1;
    expect(await recordApproval(deps, decision(request))).toEqual({ ok: false, reason: "EXPIRED" });
    expect(deps.store.get(request.id)?.status).toBe("expired");
  });

  it("refuses a missing/currently unresolvable subject and malformed external data", () => {
    expect(
      requestApproval(deps, { schemaVersion: 2, subjectId: "business", kind: "business" }),
    ).toMatchObject({ reason: "INVALID_INPUT" });
    subjects.delete("business");
    expect(
      requestApproval(deps, { schemaVersion: 1, subjectId: "business", kind: "business" }),
    ).toMatchObject({ reason: "SUBJECT_NOT_FOUND" });
  });

  it("rolls back the request or decision when audit insertion fails", async () => {
    const request = requested();
    // Duplicate event id fails after the state write; the whole UoW must roll back.
    const broken = { ...deps, nextId: () => "id-2" };
    await expect(recordApproval(broken, decision(request))).rejects.toThrow(/UNIQUE/);
    expect(deps.store.get(request.id)).toEqual(request);
    const before = counts();
    expect(() =>
      requestApproval(
        { ...deps, nextId: () => "id-2" },
        { schemaVersion: 1, subjectId: "cost", kind: "cost" },
      ),
    ).toThrow(/UNIQUE/);
    expect(counts()).toEqual(before);
  });

  it("allows only one concurrent decision on a version, without duplicate audit", async () => {
    const request = requested();
    const results = await Promise.all([
      recordApproval(deps, decision(request)),
      recordApproval(deps, decision(request)),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, reason: "STALE_VERSION" });
    expect(counts()).toEqual({ approvals: { n: 1 }, events: { n: 2 } });
    expect(await recordApproval(deps, decision(request))).toEqual({
      ok: false,
      reason: "STALE_VERSION",
    });
    expect(await recordApproval(deps, decision(request, { approvalId: "missing" }))).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
  });
});

describe("persisted approval evidence consistency", () => {
  it("refuses a mismatched decision subject or provenance instead of authorising it", async () => {
    const request = requested();
    await recordApproval(deps, decision(request));
    const stored = deps.store.get(request.id);
    if (stored?.decision === undefined) throw new Error("missing recorded decision");
    db.prepare("UPDATE approvals SET request_json=? WHERE id=?").run(
      JSON.stringify({
        ...stored,
        decision: {
          ...stored.decision,
          subject: { kind: "business", baselineHash: H2, scopeIds: ["task"] },
        },
      }),
      request.id,
    );
    expect(() => deps.store.get(request.id)).toThrow(/snapshot disagrees/);
    db.prepare("UPDATE approvals SET request_json=? WHERE id=?").run(
      JSON.stringify({
        ...stored,
        decision: { ...stored.decision, actor: "mallory" },
      }),
      request.id,
    );
    expect(() => deps.store.get(request.id)).toThrow(/snapshot disagrees/);
  });
});

// AC-2: evaluate at the execution boundary using current state, never an approved boolean.
describe("business/cost before execution", () => {
  it("blocks execution until both approvals hold, and blocks again on changed cost or business", async () => {
    const business = requested("business");
    const cost = requested("cost");
    const requirements = [business, cost].map((request) => ({
      approvalId: request.id,
      subjectId: request.subjectId,
      kind: request.subject.kind,
    }));
    const canExecute = () => checkExecutionApprovals(deps, requirements, ["po"]);
    expect(canExecute().allowed).toBe(false);
    await recordApproval(deps, decision(business));
    expect(canExecute().allowed).toBe(false);
    await recordApproval(deps, decision(cost));
    expect(canExecute().allowed).toBe(true);
    subjects.set("cost", { kind: "cost", estimateHash: H2, scopeIds: ["task"] });
    expect(canExecute()).toMatchObject({ allowed: false, reason: "STALE_REVISION" });
    subjects.set("cost", cost.subject);
    subjects.set("business", { kind: "business", baselineHash: H1, scopeIds: ["task", "extra"] });
    expect(canExecute()).toMatchObject({ allowed: false, reason: "SCOPE_NOT_COVERED" });
    subjects.delete("business");
    expect(canExecute()).toMatchObject({ allowed: false, reason: "SUBJECT_MISMATCH" });
  });
});

// AC-3: worker output, provenance booleans and impersonated actor/source never mutate approval.
describe("worker JSON is not approval authority", () => {
  it("rejects approved=true in worker results, requests, commands and records without writes", async () => {
    const request = requested();
    const before = counts();
    const worker = {
      schemaVersion: 1,
      runId: "r",
      stepId: "s",
      attemptId: "a",
      status: "succeeded",
      summary: "approved",
      artifacts: [],
      checks: [],
      findings: [],
      approved: true,
    };
    expect(stepResultSchema.safeParse(worker).success).toBe(false);
    for (const extra of [
      { approved: true },
      { actor: "po", source: "po-cli" },
      { sourceAuthenticated: true },
      { pathway: "worker" },
    ]) {
      expect(await recordApproval(deps, { ...decision(request), ...extra })).toMatchObject({
        ok: false,
        reason: "INVALID_INPUT",
      });
    }
    expect(await recordApproval(deps, worker)).toMatchObject({ reason: "INVALID_INPUT" });
    expect(
      requestApproval(deps, {
        schemaVersion: 1,
        subjectId: "business",
        kind: "business",
        approved: true,
      }),
    ).toMatchObject({ reason: "INVALID_INPUT" });
    expect(
      commandSchema.safeParse({ ...decision(request), command: "approval.decide", approved: true })
        .success,
    ).toBe(false);
    expect(deps.store.get(request.id)).toEqual(request);
    expect(counts()).toEqual(before);
  });

  it("cannot claim the CLI pathway without a trusted interactive confirmation", async () => {
    const request = requested();
    cliConfirmed = false;
    expect(await recordApproval(deps, decision(request))).toEqual({
      ok: false,
      reason: "SOURCE_NOT_AUTHENTICATED",
    });
    expect(deps.store.get(request.id)).toEqual(request);
    // Actual adapter also refuses redirected input; no `--yes` or JSON approval path exists.
    expect(
      await createInteractiveApprovalConfirmation()(request, decision(request)),
    ).toBeUndefined();
  });
});

// AC-4: actual CLI -> IPC -> use case -> SQLite, plus GitHub read-back author verification.
describe("CLI and allowlisted GitHub pathways", () => {
  it("routes a CLI decision through IPC and stores only verified provenance", async () => {
    const request = requested();
    const socketPath = join(dir, "ipc", "runtime.sock");
    server = createRuntimeIpcServer({
      socketPath,
      identity: { runtimeVersion: "1", startedAt: new Date(now).toISOString() },
      approvals: {
        requestApproval: (input) => requestApproval(deps, input),
        recordApproval: (input) => recordApproval(deps, input),
      },
    });
    await server.start();
    let stdout = "";
    const cli = {
      sendCommand,
      defaultSocketPath: socketPath,
      timeoutMs: 1000,
      version: "1",
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: () => undefined,
    };
    cliConfirmed = false;
    expect(
      await runCli(
        [
          "--json",
          "approvals",
          "decide",
          request.id,
          "--expected-version",
          "0",
          "--decision",
          "approved",
        ],
        cli,
      ),
    ).toBe(4);
    expect(stdout).toContain("SOURCE_NOT_AUTHENTICATED");
    stdout = "";
    cliConfirmed = true;
    expect(
      await runCli(
        [
          "--json",
          "approvals",
          "decide",
          request.id,
          "--expected-version",
          "0",
          "--decision",
          "approved",
        ],
        cli,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      result: { status: "approved", decision: { source: "po-cli", actor: "po" } },
    });
    expect(deps.store.get(request.id)?.status).toBe("approved");
  });

  it("keeps the IPC request active while a PO confirmation outlasts the idle timeout", async () => {
    const request = requested();
    let enterVerification: (() => void) | undefined;
    const entered = new Promise<void>((resolveEntered) => {
      enterVerification = resolveEntered;
    });
    deps = {
      ...deps,
      source: {
        async verify(req, input) {
          enterVerification?.();
          await new Promise<void>((resolveWait) => {
            setTimeout(resolveWait, 80);
          });
          return evidence(req, input);
        },
      },
    };
    const socketPath = join(dir, "ipc", "runtime.sock");
    server = createRuntimeIpcServer({
      socketPath,
      idleTimeoutMs: 30,
      identity: { runtimeVersion: "1", startedAt: new Date(now).toISOString() },
      approvals: { recordApproval: (input) => recordApproval(deps, input) },
    });
    await server.start();
    const pending = sendCommand({
      socketPath,
      timeoutMs: 1000,
      command: { ...decision(request), command: "approval.decide" },
    });
    await entered;
    expect(await pending).toMatchObject({ ok: true, result: { status: "approved" } });
  });

  it("accepts an unedited GitHub comment and stores its real actor and bound decision", async () => {
    const request = requested();
    githubComment(request);
    expect(
      await recordApproval(deps, decision(request, { pathway: "github", evidenceRef: "42" })),
    ).toMatchObject({
      ok: true,
      request: {
        decision: {
          actor: "po",
          source: "github-actor",
          evidenceRef: "github:acme/app:comment:42",
        },
      },
    });
    expect(readComment).toHaveBeenCalledWith("repos/acme/app/issues/comments/42");
  });

  it.each(["approved", "rejected"] as const)(
    "refuses an edited PO comment claiming a %s decision without state or audit changes",
    async (choice) => {
      const request = requested();
      const reason = choice === "rejected" ? "declined" : undefined;
      githubComment(
        request,
        { decision: choice, ...(reason === undefined ? {} : { reason }) },
        "po",
        "User",
        { updated_at: "2026-11-11T01:00:01Z" },
      );
      const before = counts();
      expect(
        await recordApproval(
          deps,
          decision(request, {
            pathway: "github",
            evidenceRef: "42",
            decision: choice,
            ...(reason === undefined ? {} : { reason }),
          }),
        ),
      ).toEqual({ ok: false, reason: "GITHUB_COMMENT_EDITED" });
      expect(deps.store.get(request.id)).toEqual(request);
      expect(counts()).toEqual(before);
    },
  );

  it.each([
    { created_at: undefined },
    { updated_at: undefined },
    { created_at: "not-a-time" },
    { updated_at: null },
  ])("refuses missing or malformed GitHub edit timestamps %j", async (metadata) => {
    const request = requested();
    githubComment(request, {}, "po", "User", metadata);
    const before = counts();
    expect(
      await recordApproval(deps, decision(request, { pathway: "github", evidenceRef: "42" })),
    ).toEqual({ ok: false, reason: "SOURCE_NOT_AUTHENTICATED" });
    expect(counts()).toEqual(before);
  });

  it("reports edited-comment evidence as APPROVAL_REFUSED over IPC", async () => {
    const request = requested();
    githubComment(request, {}, "po", "User", { updated_at: "2026-11-11T01:00:01Z" });
    const socketPath = join(dir, "ipc", "runtime.sock");
    server = createRuntimeIpcServer({
      socketPath,
      identity: { runtimeVersion: "1", startedAt: new Date(now).toISOString() },
      approvals: { recordApproval: (input) => recordApproval(deps, input) },
    });
    await server.start();
    expect(
      await sendCommand({
        socketPath,
        timeoutMs: 1000,
        command: {
          ...decision(request, { pathway: "github", evidenceRef: "42" }),
          command: "approval.decide",
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "APPROVAL_REFUSED", message: "Approval refused: GITHUB_COMMENT_EDITED" },
    });
    expect(deps.store.get(request.id)).toEqual(request);
  });

  it("matches GitHub allowlists without case sensitivity and retains the observed login", async () => {
    const request = requested();
    deps = { ...deps, allowedGitHubActors: ["Po"] };
    githubComment(request, {}, "pO");
    expect(
      await recordApproval(deps, decision(request, { pathway: "github", evidenceRef: "42" })),
    ).toMatchObject({ ok: true, request: { decision: { actor: "pO", source: "github-actor" } } });
    expect(
      checkExecutionApprovals(
        deps,
        [{ approvalId: request.id, subjectId: request.subjectId, kind: "business" }],
        ["PO"],
      ),
    ).toEqual({ allowed: true });
  });

  it("allows an allowlisted GitHub rejection and preserves its reason", async () => {
    const request = requested();
    githubComment(request, { decision: "rejected", reason: "declined" });
    expect(
      await recordApproval(
        deps,
        decision(request, {
          pathway: "github",
          evidenceRef: "42",
          decision: "rejected",
          reason: "declined",
        }),
      ),
    ).toMatchObject({
      ok: true,
      request: { status: "rejected", decision: { reason: "declined", source: "github-actor" } },
    });
  });

  it("refuses an unallowlisted actor and bot, without changing state or audit", async () => {
    const request = requested();
    const before = counts();
    githubComment(request, {}, "mallory");
    expect(
      await recordApproval(deps, decision(request, { pathway: "github", evidenceRef: "42" })),
    ).toEqual({ ok: false, reason: "ACTOR_NOT_ALLOWED" });
    githubComment(request, {}, "po", "Bot");
    expect(
      await recordApproval(deps, decision(request, { pathway: "github", evidenceRef: "42" })),
    ).toMatchObject({ reason: "SOURCE_NOT_AUTHENTICATED" });
    expect(counts()).toEqual(before);
  });

  it.each([
    { subjectHash: H2 },
    { approvalId: "other" },
    { version: 2 },
    { decision: "rejected" },
    { approved: true },
    { actor: "po" },
  ])("rejects mismatched or smuggled GitHub evidence %j", async (overrides) => {
    const request = requested();
    githubComment(request, overrides);
    const before = counts();
    expect(
      await recordApproval(deps, decision(request, { pathway: "github", evidenceRef: "42" })),
    ).toMatchObject({ reason: "SOURCE_NOT_AUTHENTICATED" });
    expect(counts()).toEqual(before);
  });

  it("refuses malformed/unavailable GitHub evidence and arbitrary URL references", async () => {
    const request = requested();
    for (const invalid of [null, { user: { login: "po", type: "User" }, body: "yes approved" }]) {
      comment = invalid;
      expect(
        await recordApproval(deps, decision(request, { pathway: "github", evidenceRef: "42" })),
      ).toMatchObject({ reason: "SOURCE_NOT_AUTHENTICATED" });
    }
    readComment.mockRejectedValue(new Error("offline"));
    expect(
      await recordApproval(deps, decision(request, { pathway: "github", evidenceRef: "42" })),
    ).toMatchObject({ reason: "SOURCE_NOT_AUTHENTICATED" });
    readComment.mockClear();
    expect(
      await recordApproval(
        deps,
        decision(request, { pathway: "github", evidenceRef: "https://elsewhere/42" }),
      ),
    ).toMatchObject({ reason: "SOURCE_NOT_AUTHENTICATED" });
    expect(readComment).not.toHaveBeenCalled();
  });
});
