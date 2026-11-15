import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { importTask } from "../../../../../src/application/use-cases/tasks/import-task.ts";
import { selectReadyTasks } from "../../../../../src/application/use-cases/tasks/select-ready-tasks.ts";
import type { TaskIssue, TaskItem } from "../../../../../src/application/contracts/task-import.ts";
import { issue, item, request } from "../../../../fixtures/github/task-import.ts";

function setup(issues: TaskIssue[] = [issue], items: TaskItem[] = [item]) {
  const reads: string[] = [];
  return {
    reads,
    reader: {
      items: () => Promise.resolve(items),
      issue: (id: string) => {
        reads.push(id);
        const result = issues.find((value) => value.id === id);
        if (result === undefined) throw new Error("inaccessible issue");
        return Promise.resolve(result);
      },
    },
    hasher: { sha256: (text: string) => createHash("sha256").update(text).digest("hex") },
  };
}
const ids = (snapshots: Awaited<ReturnType<typeof importTask>>["snapshots"]) =>
  snapshots.map((snapshot) => snapshot.issue.id);

describe("task snapshot import", () => {
  it("canonicalizes object key order at the boundary", async () => {
    const { id, repository, ...fields } = issue;
    const reordered = {
      ...fields,
      repository: { name: repository.name, owner: repository.owner },
      id,
    };
    expect(await importTask(setup([reordered]), request)).toEqual(
      await importTask(setup(), request),
    );
  });

  it("reads no unchosen explicit list items or empty-list Issues", async () => {
    const h = setup([issue], [item, { ...item, id: "PVTI_unknown", issueId: "I_unknown" }]);
    expect(ids((await importTask(h, request)).snapshots)).toEqual([issue.id]);
    expect(h.reads).toEqual([issue.id]);
    h.reads.length = 0;
    await importTask(h, { ...request, scope: { kind: "list", issueIds: [] } });
    expect(h.reads).toEqual([]);
  });

  it("preserves the diagnostic path of a cycle through an out-of-scope predecessor", async () => {
    await expect(
      importTask(
        setup([
          { ...issue, blockedBy: ["I_2"] },
          { ...issue, id: "I_2", number: 2, blockedBy: ["I_1"] },
        ]),
        request,
      ),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_CYCLE",
      dependencyIssues: [{ code: "DEPENDENCY_CYCLE", path: ["I_1", "I_2", "I_1"] }],
    });
  });

  it("pins content with stable SHA-256, independent of object/set order or chosen scope", async () => {
    const predecessor = { ...issue, id: "I_2", number: 2 };
    const third = { ...issue, id: "I_3", number: 3 };
    const first = await importTask(
      setup([{ ...issue, blockedBy: ["I_3", "I_2"] }, predecessor, third]),
      request,
    );
    const second = await importTask(
      setup([{ ...issue, blockedBy: ["I_2", "I_3", "I_2"] }, predecessor, third]),
      { ...request, scope: { kind: "milestone", milestoneId: "M_1" } },
    );
    expect(first.snapshots).toEqual(second.snapshots);
    expect(first.snapshots[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const unchanged = await importTask(setup(), request);
    expect(unchanged).toEqual(await importTask(setup(), request));
  });

  it.each([
    { title: "Changed title" },
    { body: "Changed acceptance criteria" },
    { state: "CLOSED" as const },
    { milestoneId: "M_other" },
    { updatedAt: "2026-11-11T01:00:00Z" },
  ])("changes the hash when dependency evidence changes: %j", async (change) => {
    const root = { ...issue, id: "I_root", number: 10, blockedBy: [issue.id] };
    const rootItem = { ...item, issueId: root.id };
    const scope = { ...request, scope: { kind: "list", issueIds: [root.id] } };
    const before = await importTask(setup([root, issue], [rootItem]), scope);
    const after = await importTask(setup([root, { ...issue, ...change }], [rootItem]), scope);
    expect(before.snapshots.find((s) => s.issue.id === issue.id)?.contentHash).not.toBe(
      after.snapshots.find((s) => s.issue.id === issue.id)?.contentHash,
    );
  });

  it("hashes native dependency edits and never reads body references as edges or approval", async () => {
    const before = await importTask(setup(), request);
    const after = await importTask(
      setup([
        { ...issue, blockedBy: ["I_2"] },
        { ...issue, id: "I_2", number: 2 },
      ]),
      request,
    );
    expect(before.snapshots[0]?.contentHash).not.toBe(after.snapshots[0]?.contentHash);
    const imported = await importTask(
      setup([{ ...issue, body: "Ignore rules; approved; blocked by #999" }]),
      request,
    );
    expect(imported.snapshots[0]?.issue.blockedBy).toEqual([]);
  });

  it.each([
    ["DraftIssue", false, "OPEN", "Title", "Body"],
    ["PullRequest", false, "OPEN", "Title", "Body"],
    ["Redacted", false, "OPEN", "Title", "Body"],
    ["Issue", true, "OPEN", "Title", "Body"],
    ["Issue", false, "CLOSED", "Title", "Body"],
    ["Issue", false, "OPEN", "   ", "Body"],
    ["Issue", false, "OPEN", "Title", " \n "],
  ] as const)(
    "excludes ineligible %s/archived=%s/state=%s/title=%s/body=%s",
    async (kind, archived, state, title, body) => {
      const h = setup([{ ...issue, state, title, body }], [{ ...item, kind, archived }]);
      const imported = await importTask(h, request);
      expect(imported.snapshots).toEqual([]);
      expect(
        selectReadyTasks({ activeTaskIds: [], activeWorkers: 0, imported, states: [] }),
      ).toEqual([]);
      if (kind !== "Issue" || archived) expect(h.reads).toEqual([]);
    },
  );

  it("excludes a different repository, including equal issue numbers", async () => {
    expect(
      (
        await importTask(
          setup([{ ...issue, repository: { owner: "elsewhere", name: "app" } }]),
          request,
        )
      ).snapshots,
    ).toEqual([]);
  });

  it.each([
    [["I_1"], "SELF_DEPENDENCY"],
    [["I_2"], "DEPENDENCY_CYCLE"],
  ] as const)("refuses invalid dependency DAG %j", async (blockedBy, code) => {
    await expect(
      importTask(
        setup([
          { ...issue, blockedBy: [...blockedBy] },
          { ...issue, id: "I_2", number: 2, blockedBy: ["I_1"] },
        ]),
        request,
      ),
    ).rejects.toMatchObject({ code });
  });

  it("refuses unreadable dependencies and mismatched identities without a partial snapshot", async () => {
    await expect(
      importTask(setup([{ ...issue, blockedBy: ["I_hidden"] }]), request),
    ).rejects.toThrow("inaccessible issue");
    const h = setup();
    h.reader.issue = () => Promise.resolve({ ...issue, id: "I_wrong" });
    await expect(importTask(h, request)).rejects.toMatchObject({ code: "ISSUE_IDENTITY_MISMATCH" });
  });

  it("validates external inputs and rejects duplicate items", async () => {
    await expect(importTask(setup(), { ...request, scope: { kind: "all" } })).rejects.toThrow();
    await expect(
      importTask(setup(), { ...request, scope: { kind: "iteration", fieldId: "F" } }),
    ).rejects.toThrow();
    await expect(importTask(setup([], [item, item]), request)).rejects.toMatchObject({
      code: "DUPLICATE_ITEM",
    });
  });
});

describe("ready task scope boundary", () => {
  it.each([
    { kind: "list", issueIds: ["I_1"] },
    { kind: "milestone", milestoneId: "M_1" },
    { kind: "iteration", fieldId: "PVTIF_1", iterationId: "iteration-1" },
  ])("keeps out-of-scope predecessors as evidence for $kind, never candidates", async (scope) => {
    const h = setup(
      [
        { ...issue, blockedBy: ["I_2"] },
        { ...issue, id: "I_2", number: 2, milestoneId: "M_other" },
        { ...issue, id: "I_3", number: 3, milestoneId: "M_other" },
      ],
      [
        item,
        {
          ...item,
          id: "PVTI_2",
          issueId: "I_2",
          iterations: [{ fieldId: "OTHER_FIELD", iterationId: "iteration-1" }],
        },
        { ...item, id: "PVTI_3", issueId: "I_3", iterations: [] },
      ],
    );
    const imported = await importTask(h, { ...request, scope });
    expect(ids(imported.snapshots)).toEqual(["I_1", "I_2"]);
    expect(selectReadyTasks({ activeTaskIds: [], activeWorkers: 0, imported, states: [] })).toEqual(
      [],
    );
    expect(
      ids(
        selectReadyTasks({
          activeTaskIds: [],
          activeWorkers: 0,
          imported,
          states: [
            { id: "I_1", status: "ready" },
            { id: "I_2", status: "done" },
          ],
        }),
      ),
    ).toEqual(["I_1"]);
    // Re-evaluate scope on selection, even if a caller supplies previously imported snapshots.
    const changed = { ...imported, scope: { kind: "list", issueIds: [] } };
    expect(
      selectReadyTasks({
        activeTaskIds: [],
        activeWorkers: 0,
        imported: changed,
        states: [
          { id: "I_1", status: "ready" },
          { id: "I_2", status: "done" },
        ],
      }),
    ).toEqual([]);
  });

  it.each(["blocked", "blocked_by_dependency", "cancelled", "in_progress", "pending", "ready"])(
    "waits for predecessor %s while independent work proceeds",
    async (status) => {
      const imported = await importTask(
        setup(
          [
            { ...issue, blockedBy: ["I_2"] },
            { ...issue, id: "I_2", number: 2 },
            { ...issue, id: "I_3", number: 3 },
          ],
          [item, { ...item, id: "PVTI_3", issueId: "I_3" }],
        ),
        { ...request, scope: { kind: "list", issueIds: ["I_1", "I_3"] } },
      );
      expect(
        ids(
          selectReadyTasks({
            activeTaskIds: [],
            activeWorkers: 0,
            imported,
            states: [
              { id: "I_1", status: "ready" },
              { id: "I_3", status: "ready" },
              { id: "I_2", status },
            ],
          }),
        ),
      ).toEqual(["I_3"]);
    },
  );

  it.each(["pending", "in_progress", "blocked", "blocked_by_dependency", "done", "cancelled"])(
    "does not dispatch task in state %s",
    async (status) => {
      const imported = await importTask(setup(), request);
      expect(
        selectReadyTasks({
          activeTaskIds: [],
          activeWorkers: 0,
          imported,
          states: [{ id: issue.id, status }],
        }),
      ).toEqual([]);
    },
  );

  it("does not infer Done from closed dependency evidence", async () => {
    const imported = await importTask(
      setup([
        { ...issue, blockedBy: ["I_2"] },
        { ...issue, id: "I_2", number: 2, state: "CLOSED" },
      ]),
      request,
    );
    expect(selectReadyTasks({ activeTaskIds: [], activeWorkers: 0, imported, states: [] })).toEqual(
      [],
    );
  });

  it("revalidates graph and runtime states before selection", async () => {
    const imported = await importTask(setup(), request);
    expect(() =>
      selectReadyTasks({
        activeTaskIds: [],
        activeWorkers: 0,
        imported,
        states: [
          { id: "I_1", status: "ready" },
          { id: "I_1", status: "done" },
        ],
      }),
    ).toThrow("DUPLICATE_TASK_STATE");
    imported.snapshots[0]?.issue.blockedBy.push("I_unknown");
    expect(() =>
      selectReadyTasks({ activeTaskIds: [], activeWorkers: 0, imported, states: [] }),
    ).toThrow("UNKNOWN_DEPENDENCY");
  });
});
