import { describe, expect, it } from "vitest";
import { reconcileGithub } from "../../../../../src/application/use-cases/sync/reconcile-github.ts";
import { enqueue, harness, START } from "./outbox-fakes.ts";

const iso = (ms: number) => new Date(ms).toISOString();

describe("reconcileGithub", () => {
  it("records an operation as succeeded when its marker is on the remote, without sending", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1", { state: "outcome_unknown", attemptCount: 1 });
    h.github.lookupScript = [{ kind: "found", remoteIdentity: "issue_comment:acme/app:99" }];

    const report = await reconcileGithub(h.deps);

    expect(report.entries).toEqual([
      { operationKey: "op-1", outcome: "succeeded", remoteIdentity: "issue_comment:acme/app:99" },
    ]);
    expect(h.outbox.get("op-1")).toMatchObject({
      state: "succeeded",
      remoteIdentity: "issue_comment:acme/app:99",
      lastError: null,
    });
    expect(h.github.sends).toEqual([]);
    expect(h.github.lookups[0]).toMatchObject({ operationKey: "op-1", notBefore: iso(START) });
  });

  it("makes an absent operation pending only after the grace period", async () => {
    const h = harness({ reconcileGraceMs: 60_000 });
    enqueue(h.outbox, h.artifacts, "op-1", {
      state: "outcome_unknown",
      attemptCount: 1,
      updatedAt: iso(START),
    });

    h.clock.ms = START + 59_999;
    const early = await reconcileGithub(h.deps);
    expect(early.entries[0]).toMatchObject({ outcome: "waiting" });
    expect(h.outbox.state("op-1")).toBe("outcome_unknown");

    h.clock.ms = START + 60_000;
    const later = await reconcileGithub(h.deps);
    expect(later.entries[0]).toMatchObject({ outcome: "pending" });
    expect(h.outbox.state("op-1")).toBe("pending");
  });

  it("finds an operation even inside the grace period", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1", { state: "outcome_unknown", attemptCount: 1 });
    h.github.lookupScript = [{ kind: "found", remoteIdentity: "r1" }];
    const report = await reconcileGithub(h.deps);
    expect(report.entries[0]).toMatchObject({ outcome: "succeeded" });
  });

  it("turns an in-flight row left by a crash into an unknown outcome before searching", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1", { state: "in_flight", attemptCount: 1 });
    h.github.lookupScript = [{ kind: "found", remoteIdentity: "r1" }];
    await reconcileGithub(h.deps);
    expect(h.outbox.events.map((e) => e.kind)).toEqual([
      "outbox.attempt_outcome_unknown",
      "outbox.reconciled_found",
    ]);
    expect(h.outbox.state("op-1")).toBe("succeeded");
  });

  it("restarts the grace period for a recovered in-flight row", async () => {
    const h = harness({ reconcileGraceMs: 60_000 });
    enqueue(h.outbox, h.artifacts, "op-1", { state: "in_flight", attemptCount: 1 });
    h.clock.ms = START + 3_600_000;
    const report = await reconcileGithub(h.deps);
    expect(report.entries[0]).toMatchObject({ outcome: "waiting" });
    expect(h.outbox.get("op-1")).toMatchObject({
      state: "outcome_unknown",
      lastError: "INTERRUPTED",
      updatedAt: iso(START + 3_600_000),
    });
  });

  it("changes nothing and stops the pass when GitHub cannot be read", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1", { state: "outcome_unknown", attemptCount: 1 });
    enqueue(h.outbox, h.artifacts, "op-2", { state: "outcome_unknown", attemptCount: 1 });
    h.github.lookupScript = [{ kind: "unavailable", code: "UNREACHABLE" }];

    const report = await reconcileGithub(h.deps);

    expect(report.githubUnavailable).toBe(true);
    expect(report.entries).toEqual([
      { operationKey: "op-1", outcome: "unavailable", code: "UNREACHABLE" },
      { operationKey: "op-2", outcome: "deferred" },
    ]);
    expect(h.github.lookups).toHaveLength(1);
    expect(h.outbox.state("op-1")).toBe("outcome_unknown");
    expect(h.outbox.state("op-2")).toBe("outcome_unknown");
    expect(h.outbox.events).toEqual([]);
  });

  it("treats a thrown lookup as unavailable, never as absent", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1", { state: "outcome_unknown", attemptCount: 1 });
    h.clock.ms = START + 10 * 60_000;
    h.github.lookupScript = [new Error("socket hang up")];
    const report = await reconcileGithub(h.deps);
    expect(report.entries[0]).toMatchObject({ outcome: "unavailable", code: "LOOKUP_FAILED" });
    expect(h.outbox.state("op-1")).toBe("outcome_unknown");
  });

  it("leaves an operation alone when its payload cannot be verified", async () => {
    const h = harness();
    enqueue(h.outbox, h.artifacts, "op-1", {
      state: "outcome_unknown",
      attemptCount: 1,
      payloadHash: "f".repeat(64),
    });
    const report = await reconcileGithub(h.deps);
    expect(report.entries).toEqual([
      { operationKey: "op-1", outcome: "unreadable", code: "PAYLOAD_UNREADABLE" },
    ]);
    expect(h.github.lookups).toEqual([]);
    expect(h.outbox.state("op-1")).toBe("outcome_unknown");
  });

  it("ignores operations that are pending, succeeded or failed", async () => {
    const h = harness();
    for (const state of ["pending", "succeeded", "failed"] as const) {
      enqueue(h.outbox, h.artifacts, `op-${state}`, {
        state,
        remoteIdentity: state === "succeeded" ? "r" : null,
      });
    }
    const report = await reconcileGithub(h.deps);
    expect(report.entries).toEqual([]);
    expect(h.github.lookups).toEqual([]);
  });

  it("reports a row another writer moved first as stale", async () => {
    const h = harness();
    const record = enqueue(h.outbox, h.artifacts, "op-1", {
      state: "outcome_unknown",
      attemptCount: 1,
    });
    h.github.lookupScript = [{ kind: "found", remoteIdentity: "r1" }];
    // Another writer settles the row while the read-back is in progress.
    const original = h.outbox.listUnresolved.bind(h.outbox);
    h.outbox.listUnresolved = () => {
      const listed = original();
      h.outbox.records.set("op-1", { ...record, state: "succeeded", remoteIdentity: "r0" });
      return listed;
    };
    const report = await reconcileGithub(h.deps);
    expect(report.entries[0]).toMatchObject({ outcome: "stale" });
    expect(h.outbox.get("op-1")).toMatchObject({ remoteIdentity: "r0" });
  });
});
