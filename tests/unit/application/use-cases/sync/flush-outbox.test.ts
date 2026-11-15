import { describe, expect, it } from "vitest";
import { flushOutbox } from "../../../../../src/application/use-cases/sync/flush-outbox.ts";
import { COMMENT, enqueue, harness, START } from "./outbox-fakes.ts";

const iso = (ms: number) => new Date(ms).toISOString();

describe("flushOutbox", () => {
  it("persists in_flight before the call and succeeded after it", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1");
    const seenDuringCall: unknown[] = [];
    h.github.onSend = () => seenDuringCall.push(h.outbox.get("op-1"));
    h.github.sendScript = [{ kind: "succeeded", remoteIdentity: "issue_comment:acme/app:1" }];

    const report = await flushOutbox(h.deps);

    expect(seenDuringCall).toEqual([
      expect.objectContaining({ state: "in_flight", attemptCount: 1 }),
    ]);
    expect(report.attempts).toEqual([
      { operationKey: "op-1", outcome: "succeeded", remoteIdentity: "issue_comment:acme/app:1" },
    ]);
    expect(h.outbox.get("op-1")).toMatchObject({
      state: "succeeded",
      attemptCount: 1,
      remoteIdentity: "issue_comment:acme/app:1",
    });
    expect(h.github.sends).toEqual([{ operation: COMMENT, operationKey: "op-1" }]);
    expect(h.outbox.events.map((e) => e.kind)).toEqual([
      "outbox.begin_attempt",
      "outbox.attempt_succeeded",
    ]);
    expect(h.outbox.events.every((e) => e.correlationId === "op-1")).toBe(true);
  });

  it("does not resend a succeeded operation on the next pass", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1");
    await flushOutbox(h.deps);
    await flushOutbox(h.deps);
    expect(h.github.sends).toHaveLength(1);
  });

  it("records an unknown outcome and stops without sending again or searching in the same pass", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1");
    enqueue(h.outbox, h.artifacts, "op-2");
    h.github.sendScript = [{ kind: "outcome_unknown", code: "TIMEOUT" }];

    const report = await flushOutbox(h.deps);

    expect(report.stopped).toBe("OUTCOME_UNKNOWN");
    expect(report.attempts).toEqual([
      { operationKey: "op-1", outcome: "outcome_unknown", code: "TIMEOUT" },
    ]);
    expect(h.outbox.get("op-1")).toMatchObject({ state: "outcome_unknown", lastError: "TIMEOUT" });
    expect(h.outbox.state("op-2")).toBe("pending");
    expect(h.github.sends).toHaveLength(1);
  });

  it("timeout after success: the next pass finds the marker and never sends again", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1");
    h.github.sendScript = [{ kind: "outcome_unknown", code: "TIMEOUT" }];
    await flushOutbox(h.deps);

    // The remote did apply the request.
    h.clock.ms = START + 120_000;
    h.github.lookupScript = [{ kind: "found", remoteIdentity: "issue_comment:acme/app:5" }];
    const second = await flushOutbox(h.deps);

    expect(second.reconcile.entries).toEqual([
      { operationKey: "op-1", outcome: "succeeded", remoteIdentity: "issue_comment:acme/app:5" },
    ]);
    expect(second.attempts).toEqual([]);
    expect(h.github.sends).toHaveLength(1);
    expect(h.outbox.state("op-1")).toBe("succeeded");
  });

  it("timeout before the effect: reads the remote, sees nothing after the grace period, then sends", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1");
    h.github.sendScript = [{ kind: "outcome_unknown", code: "TIMEOUT" }];
    await flushOutbox(h.deps);

    h.clock.ms = START + 120_000;
    const second = await flushOutbox(h.deps);

    expect(h.github.lookups).toHaveLength(1);
    expect(second.attempts).toEqual([
      { operationKey: "op-1", outcome: "succeeded", remoteIdentity: "remote:op-1" },
    ]);
    expect(h.github.sends).toHaveLength(2);
    expect(h.outbox.get("op-1")).toMatchObject({ state: "succeeded", attemptCount: 2 });
  });

  it("does not send again inside the grace period even when the remote shows nothing yet", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1");
    h.github.sendScript = [{ kind: "outcome_unknown", code: "TIMEOUT" }];
    await flushOutbox(h.deps);

    h.clock.ms = START + 1_000;
    const second = await flushOutbox(h.deps);

    expect(second.reconcile.entries[0]).toMatchObject({ outcome: "waiting" });
    expect(second.attempts).toEqual([]);
    expect(h.github.sends).toHaveLength(1);
    expect(h.outbox.state("op-1")).toBe("outcome_unknown");
  });

  it("keeps everything local and sends nothing while GitHub cannot be read", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-unknown", { state: "outcome_unknown", attemptCount: 1 });
    enqueue(h.outbox, h.artifacts, "op-new");
    h.github.lookupScript = [{ kind: "unavailable", code: "UNREACHABLE" }];

    const report = await flushOutbox(h.deps);

    expect(report.stopped).toBe("GITHUB_UNAVAILABLE");
    expect(h.github.sends).toEqual([]);
    expect(h.outbox.state("op-unknown")).toBe("outcome_unknown");
    expect(h.outbox.state("op-new")).toBe("pending");
  });

  it("honours Retry-After: waits, then sends once the wait has passed", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1");
    h.github.sendScript = [
      { kind: "rejected_retryable", code: "RATE_LIMITED", retryAfterMs: 90_000 },
    ];

    const first = await flushOutbox(h.deps);

    expect(first.stopped).toBe("RATE_LIMITED");
    expect(first.attempts).toEqual([
      {
        operationKey: "op-1",
        outcome: "rejected_retry",
        code: "RATE_LIMITED",
        notBefore: iso(START + 90_000),
      },
    ]);
    expect(h.outbox.get("op-1")).toMatchObject({
      state: "pending",
      nextAttemptAt: iso(START + 90_000),
      lastError: "RATE_LIMITED",
    });

    h.clock.ms = START + 89_999;
    await flushOutbox(h.deps);
    expect(h.github.sends).toHaveLength(1);

    h.clock.ms = START + 90_000;
    await flushOutbox(h.deps);
    expect(h.github.sends).toHaveLength(2);
    expect(h.outbox.state("op-1")).toBe("succeeded");
    // A refusal means nothing was applied: no read-back is needed before the retry.
    expect(h.github.lookups).toEqual([]);
  });

  it("backs off exponentially, never below the remote's own wait, without a read-back", async () => {
    const h = harness({ jitter: () => 0.999999 });
    enqueue(h.outbox, h.artifacts, "op-1");
    h.github.sendScript = [
      { kind: "rejected_retryable", code: "RATE_LIMITED" },
      { kind: "rejected_retryable", code: "RATE_LIMITED", retryAfterMs: 500_000 },
    ];
    const first = await flushOutbox(h.deps);
    expect(first.attempts[0]).toMatchObject({ notBefore: iso(START + 1_000 - 1) });

    h.clock.ms = START + 1_000;
    const second = await flushOutbox(h.deps);
    expect(second.attempts[0]).toMatchObject({ notBefore: iso(START + 1_000 + 500_000) });
  });

  it("gives up without sending once the attempt budget is spent, keeping the last error", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1", {
      attemptCount: 3,
      lastError: "RATE_LIMITED",
    });
    const report = await flushOutbox(h.deps);
    expect(report.attempts).toEqual([
      { operationKey: "op-1", outcome: "gave_up", code: "RATE_LIMITED" },
    ]);
    expect(h.outbox.state("op-1")).toBe("failed");
    expect(h.github.sends).toEqual([]);
  });

  it("marks a permanently refused operation failed and continues with the next one", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1");
    enqueue(h.outbox, h.artifacts, "op-2");
    h.github.sendScript = [{ kind: "rejected_final", code: "HTTP_422" }];
    const report = await flushOutbox(h.deps);
    expect(report.stopped).toBeUndefined();
    expect(h.outbox.get("op-1")).toMatchObject({ state: "failed", lastError: "HTTP_422" });
    expect(h.outbox.state("op-2")).toBe("succeeded");
  });

  it("treats a thrown send as an unknown outcome, not as a refusal", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1");
    h.github.sendScript = [new Error("boom")];
    const report = await flushOutbox(h.deps);
    expect(report.attempts[0]).toMatchObject({ outcome: "outcome_unknown", code: "SEND_FAILED" });
    expect(h.outbox.state("op-1")).toBe("outcome_unknown");
  });

  it("after a crash during the call the row is in_flight: the restart searches it and does not resend", async () => {
    // What a killed process leaves behind is exactly the row persisted before the call (see the
    // first test): in_flight with the attempt counted. The remote applied the request.
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1", { state: "in_flight", attemptCount: 1 });
    h.github.lookupScript = [{ kind: "found", remoteIdentity: "issue_comment:acme/app:8" }];

    const report = await flushOutbox(h.deps);

    expect(report.reconcile.entries[0]).toMatchObject({ outcome: "succeeded" });
    expect(h.github.sends).toEqual([]);
    expect(h.outbox.state("op-1")).toBe("succeeded");
  });

  it.each([
    ["not JSON", "not json", "PAYLOAD_NOT_JSON"],
    [
      "schema invalid",
      JSON.stringify({ schemaVersion: 1, operation: { type: "issue.comment" } }),
      "PAYLOAD_INVALID",
    ],
    [
      "a different kind",
      JSON.stringify({
        schemaVersion: 1,
        operation: { type: "issue.create", repo: COMMENT.repo, title: "t", body: "b" },
      }),
      "KIND_MISMATCH",
    ],
  ])("never sends a payload that is %s", async (_name, content, code) => {
    const h = harness();
    const ref = h.artifacts.put("payloads/op-1.json", content);
    h.outbox.seed({
      operationKey: "op-1",
      kind: "issue.comment",
      payloadRef: ref.path,
      payloadHash: ref.sha256,
    });
    const report = await flushOutbox(h.deps);
    expect(report.attempts).toEqual([{ operationKey: "op-1", outcome: "gave_up", code }]);
    expect(h.outbox.state("op-1")).toBe("failed");
    expect(h.github.sends).toEqual([]);
  });

  it("never sends a payload whose hash no longer matches", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1", { payloadHash: "e".repeat(64) });
    const report = await flushOutbox(h.deps);
    expect(report.attempts[0]).toMatchObject({ outcome: "gave_up", code: "PAYLOAD_UNREADABLE" });
    expect(h.github.sends).toEqual([]);
  });

  it("never sends an operation key that cannot form a marker", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "bad--key");
    const report = await flushOutbox(h.deps);
    expect(report.attempts[0]).toMatchObject({ outcome: "gave_up", code: "INVALID_OPERATION_KEY" });
    expect(h.github.sends).toEqual([]);
  });

  it("limits a pass to the batch size", async () => {
    const h = harness({ batchSize: 2 });
    for (const key of ["a", "b", "c"]) enqueue(h.outbox, h.artifacts, key);
    await flushOutbox(h.deps);
    expect(h.github.sends.map((s) => s.operationKey)).toEqual(["a", "b"]);
    expect(h.outbox.state("c")).toBe("pending");
  });
});
