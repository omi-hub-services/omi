import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { importTask } from "../../../../../src/application/use-cases/tasks/import-task.ts";
import { storeTaskSnapshots } from "../../../../../src/application/use-cases/tasks/store-task-snapshots.ts";
import type {
  StateChange,
  StateCommitResult,
} from "../../../../../src/application/ports/state-unit-of-work.ts";
import { issue, item, request } from "../../../../fixtures/github/task-import.ts";

const hasher = { sha256: (text: string) => createHash("sha256").update(text).digest("hex") };
const reader = {
  items: () => Promise.resolve([item]),
  issue: () => Promise.resolve(issue),
};
const imported = () => importTask({ reader, hasher }, request);

function setup(results: StateCommitResult[] = []) {
  const changes: StateChange[] = [];
  let next = 0;
  return {
    changes,
    deps: {
      hasher,
      now: () => Date.UTC(2026, 10, 13),
      nextId: () => `id-${String((next += 1))}`,
      unitOfWork: {
        commit: (change: StateChange): StateCommitResult => {
          changes.push(change);
          return results.shift() ?? { ok: true, newVersion: 0, eventSequence: 1 };
        },
      },
    },
  };
}

describe("store task snapshots", () => {
  it("commits one task_snapshot change with a task.imported event per snapshot", async () => {
    const h = setup();
    const result = storeTaskSnapshots(h.deps, {
      projectId: "proj",
      imported: await imported(),
    });
    expect(result).toEqual({
      ok: true,
      snapshots: [{ taskId: "task-1", issueNodeId: "I_1", issueNumber: 1, outcome: "stored" }],
    });
    const only = h.changes[0];
    expect(only?.target).toMatchObject({
      kind: "task_snapshot",
      snapshot: { id: "task-1", projectId: "proj", issueNodeId: "I_1", issueNumber: 1 },
    });
    expect(only?.event).toMatchObject({ kind: "task.imported", subject: "task_snapshot:task-1" });
    expect(only?.at).toBe("2026-11-13T00:00:00.000Z");
  });

  it("reports an unchanged snapshot as a no-op, not an error", async () => {
    const h = setup([{ ok: false, reason: "UNCHANGED" }]);
    const result = storeTaskSnapshots(h.deps, {
      projectId: "proj",
      imported: await imported(),
    });
    expect(result).toMatchObject({
      ok: true,
      snapshots: [{ taskId: "task-1", outcome: "unchanged" }],
    });
  });

  it("returns a typed rejection when the Issue number belongs to another Issue", async () => {
    const h = setup([{ ok: false, reason: "CONFLICT" }]);
    expect(storeTaskSnapshots(h.deps, { projectId: "proj", imported: await imported() })).toEqual({
      ok: false,
      reason: "ISSUE_NUMBER_CONFLICT",
      issueNodeId: "I_1",
    });
  });

  it("rejects a snapshot whose content hash does not match its Issue content", async () => {
    const h = setup();
    const value = await imported();
    const forged = {
      ...value,
      snapshots: value.snapshots.map((s) => ({ ...s, contentHash: "a".repeat(64) })),
    };
    expect(storeTaskSnapshots(h.deps, { projectId: "proj", imported: forged })).toEqual({
      ok: false,
      reason: "HASH_MISMATCH",
      issueNodeId: "I_1",
    });
    expect(h.changes).toEqual([]);
  });

  it("rejects malformed input before writing", () => {
    const h = setup();
    expect(storeTaskSnapshots(h.deps, { projectId: "bad id", imported: {} })).toEqual({
      ok: false,
      reason: "INVALID_INPUT",
    });
    expect(h.changes).toEqual([]);
  });
});
