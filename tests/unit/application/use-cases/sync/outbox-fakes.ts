import { createHash } from "node:crypto";
import type { GithubOperation } from "../../../../../src/application/contracts/github-operation.ts";
import type {
  GithubRemote,
  LookupOutcome,
  LookupRequest,
  SendOutcome,
  SendRequest,
} from "../../../../../src/application/ports/github-remote.ts";
import type {
  OutboxRecord,
  OutboxStore,
  OutboxTransition,
  OutboxTransitionResult,
} from "../../../../../src/application/ports/outbox-store.ts";
import type { AuditEvent } from "../../../../../src/application/ports/state-unit-of-work.ts";
import type { FlushOutboxDeps } from "../../../../../src/application/use-cases/sync/flush-outbox.ts";

export const START = Date.parse("2026-11-11T08:00:00.000Z");

export class InMemoryOutbox implements OutboxStore {
  readonly records = new Map<string, OutboxRecord>();
  readonly events: AuditEvent[] = [];

  seed(partial: Partial<OutboxRecord> & Pick<OutboxRecord, "operationKey">): OutboxRecord {
    const record: OutboxRecord = {
      kind: "issue.comment",
      subject: "run-1",
      payloadRef: `payloads/${partial.operationKey}.json`,
      payloadHash: "0".repeat(64),
      state: "pending",
      attemptCount: 0,
      remoteIdentity: null,
      nextAttemptAt: null,
      lastError: null,
      createdAt: new Date(START).toISOString(),
      updatedAt: new Date(START).toISOString(),
      ...partial,
    };
    this.records.set(record.operationKey, record);
    return record;
  }

  get(operationKey: string): OutboxRecord | undefined {
    return this.records.get(operationKey);
  }

  state(operationKey: string): string | undefined {
    return this.records.get(operationKey)?.state;
  }

  listUnresolved(): readonly OutboxRecord[] {
    return [...this.records.values()].filter(
      (r) => r.state === "in_flight" || r.state === "outcome_unknown",
    );
  }

  listDue(now: string, limit: number): readonly OutboxRecord[] {
    return [...this.records.values()]
      .filter((r) => r.state === "pending" && (r.nextAttemptAt === null || r.nextAttemptAt <= now))
      .slice(0, limit);
  }

  transition(change: OutboxTransition): OutboxTransitionResult {
    const current = this.records.get(change.operationKey);
    if (current === undefined) return { ok: false, reason: "NOT_FOUND" };
    if (
      current.state !== change.expectedState ||
      current.attemptCount !== change.expectedAttemptCount
    ) {
      return { ok: false, reason: "STALE_STATE" };
    }
    const next: OutboxRecord = {
      ...current,
      state: change.to,
      attemptCount: change.attemptCount,
      remoteIdentity: change.remoteIdentity,
      nextAttemptAt: change.nextAttemptAt,
      lastError: change.lastError,
      updatedAt: change.at,
    };
    this.records.set(change.operationKey, next);
    this.events.push(change.event);
    return { ok: true, record: next };
  }
}

/** Artifact reader with the real contract: wrong hash or unknown path throws. */
export class FakeArtifacts {
  private readonly files = new Map<string, { bytes: Uint8Array; sha256: string }>();

  put(path: string, content: string | Uint8Array): { path: string; sha256: string } {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.files.set(path, { bytes, sha256 });
    return { path, sha256 };
  }

  putOperation(operationKey: string, operation: GithubOperation): { path: string; sha256: string } {
    return this.put(
      `payloads/${operationKey}.json`,
      JSON.stringify({ schemaVersion: 1, operation }),
    );
  }

  read(reference: { path: string; sha256: string }): Uint8Array {
    const file = this.files.get(reference.path);
    if (file?.sha256 !== reference.sha256) throw new Error("ARTIFACT_UNAVAILABLE");
    return file.bytes;
  }
}

export const COMMENT = {
  type: "issue.comment",
  repo: "acme/app",
  issueNumber: 7,
  body: "Run finished",
} satisfies GithubOperation;

/** Adds an outbox row whose payload is stored and pinned by hash. */
export function enqueue(
  outbox: InMemoryOutbox,
  artifacts: FakeArtifacts,
  operationKey: string,
  partial: Partial<OutboxRecord> = {},
  operation: GithubOperation = COMMENT,
): OutboxRecord {
  const { path, sha256 } = artifacts.putOperation(operationKey, operation);
  return outbox.seed({
    operationKey,
    kind: operation.type,
    payloadRef: path,
    payloadHash: sha256,
    ...partial,
  });
}

export class ScriptedRemote implements GithubRemote {
  readonly sends: SendRequest[] = [];
  readonly lookups: LookupRequest[] = [];
  sendScript: (SendOutcome | Error)[] = [];
  lookupScript: (LookupOutcome | Error)[] = [];
  /** Runs inside `send`, i.e. while the call is in flight. */
  onSend: (request: SendRequest) => void = () => undefined;

  send(request: SendRequest): Promise<SendOutcome> {
    this.sends.push(request);
    this.onSend(request);
    const next = this.sendScript.shift() ?? {
      kind: "succeeded" as const,
      remoteIdentity: `remote:${request.operationKey}`,
    };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }

  lookup(request: LookupRequest): Promise<LookupOutcome> {
    this.lookups.push(request);
    const next = this.lookupScript.shift() ?? { kind: "absent" as const };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

export interface Harness {
  readonly outbox: InMemoryOutbox;
  readonly artifacts: FakeArtifacts;
  readonly github: ScriptedRemote;
  readonly clock: { ms: number };
  readonly deps: FlushOutboxDeps;
}

export function harness(overrides: Partial<FlushOutboxDeps> = {}): Harness {
  const outbox = new InMemoryOutbox();
  const artifacts = new FakeArtifacts();
  const github = new ScriptedRemote();
  const clock = { ms: START };
  let eventCounter = 0;
  const deps: FlushOutboxDeps = {
    outbox,
    artifacts,
    github,
    now: () => clock.ms,
    newEventId: () => `event-${String((eventCounter += 1))}`,
    reconcileGraceMs: 60_000,
    retryBudget: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
    jitter: () => 0,
    batchSize: 50,
    ...overrides,
  };
  return { outbox, artifacts, github, clock, deps };
}
