import { z } from "zod";
import { describe, expect, it } from "vitest";
import { importTask } from "../../../src/application/use-cases/tasks/import-task.ts";
import { selectReadyTasks } from "../../../src/application/use-cases/tasks/select-ready-tasks.ts";
import { createGithubTaskReader } from "../../../src/infrastructure/github/github-task-reader.ts";
import { sha256ContentHasher } from "../../../src/infrastructure/artifacts/sha256-content-hasher.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import { createGhApiTransport } from "../../../src/infrastructure/github/gh-api-transport.ts";
import type { HttpRequest } from "../../../src/infrastructure/github/github-transport.ts";
import type { TaskIssue } from "../../../src/application/contracts/task-import.ts";
import { issue, request } from "../../fixtures/github/task-import.ts";

/** Synthetic wire fixtures: one node per page exercises every nested connection offline. */
function setup(fault = "", stage = "TaskItems", maxPages = 20) {
  const requests: HttpRequest[] = [];
  const issues: TaskIssue[] = [
    { ...issue, blockedBy: ["I_2", "I_3"] },
    { ...issue, id: "I_2", number: 2, state: "CLOSED", blockedBy: [] },
    { ...issue, id: "I_3", number: 3, blockedBy: [] },
  ];
  const items = [
    { id: "PVTI_1", isArchived: false, content: { __typename: "Issue", id: "I_1" } },
    { id: "PVTI_draft", isArchived: false, content: { __typename: "DraftIssue" } },
    { id: "PVTI_pr", isArchived: false, content: { __typename: "PullRequest" } },
    { id: "PVTI_hidden", isArchived: false, content: null },
    { id: "PVTI_archived", isArchived: true, content: { __typename: "Issue", id: "I_archived" } },
  ];
  const transport = {
    send(http: HttpRequest) {
      requests.push(http);
      const { query, variables } = z
        .object({
          query: z.string(),
          variables: z.object({ id: z.string(), after: z.string().nullable() }),
        })
        .parse(http.body);
      const affected = query.includes(stage);
      const index = Number(variables.after ?? "0");
      const page = (nodes: readonly unknown[]) => ({
        totalCount: nodes.length,
        nodes: affected && fault === "null-node" ? [null] : nodes.slice(index, index + 1),
        pageInfo: {
          hasNextPage: affected && fault === "truncate" ? false : index + 1 < nodes.length,
          endCursor:
            affected && fault === "null-cursor"
              ? null
              : affected && fault === "repeat-cursor"
                ? "0"
                : String(index + 1),
        },
      });
      let node: unknown;
      if (query.includes("TaskItems")) {
        node = { id: variables.id, __typename: "ProjectV2", items: page(items) };
      } else if (query.includes("TaskIterations")) {
        node = {
          id: variables.id,
          __typename: "ProjectV2Item",
          fieldValues: page([
            { __typename: "ProjectV2ItemFieldTextValue" },
            {
              __typename: "ProjectV2ItemFieldIterationValue",
              iterationId: "iteration-1",
              field: { id: "PVTIF_1" },
            },
            {
              __typename: "ProjectV2ItemFieldIterationValue",
              iterationId: "iteration-other",
              field: { id: "PVTIF_other" },
            },
          ]),
        };
      } else {
        const source = issues.find((value) => value.id === variables.id);
        node =
          source === undefined
            ? null
            : {
                ...source,
                id: affected && fault === "identity" ? "I_wrong" : source.id,
                __typename: "Issue",
                repository: {
                  owner: { login: source.repository.owner },
                  name: source.repository.name,
                },
                milestone: source.milestoneId === null ? null : { id: source.milestoneId },
                title:
                  affected && fault === "changed" && index > 0 ? "Changed mid-read" : source.title,
                blockedBy: page(source.blockedBy.map((id) => ({ id }))),
              };
      }
      const body =
        affected && fault === "malformed"
          ? { data: { node: {} } }
          : affected && fault === "graphql-errors"
            ? { data: { node }, errors: [{ message: "private detail" }] }
            : { data: { node } };
      return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(body) });
    },
  };
  const client = createGithubRestClient({
    transport,
    sleep: () => Promise.resolve(),
    now: () => 0,
    random: () => 0,
  });
  return { reader: createGithubTaskReader(client, maxPages), requests, issues, transport };
}

describe("GitHub task import read contract", () => {
  it("imports all item/iteration/dependency pages and preserves native dependency closure", async () => {
    const h = setup();
    const imported = await importTask(
      { reader: h.reader, hasher: sha256ContentHasher },
      { ...request, scope: { kind: "iteration", fieldId: "PVTIF_1", iterationId: "iteration-1" } },
    );
    expect(imported.items.map((value) => value.kind)).toEqual([
      "Issue",
      "DraftIssue",
      "PullRequest",
      "Redacted",
      "Issue",
    ]);
    expect(imported.items[0]?.iterations).toHaveLength(2);
    expect(imported.snapshots.map((value) => value.issue.id)).toEqual(["I_1", "I_2", "I_3"]);
    expect(imported.snapshots[0]?.issue.blockedBy).toEqual(["I_2", "I_3"]);
    expect(selectReadyTasks({ imported, states: [] })).toEqual([]);
    expect(
      selectReadyTasks({
        imported,
        states: [
          { id: "I_2", status: "done" },
          { id: "I_3", status: "done" },
        ],
      }).map((value) => value.issue.id),
    ).toEqual(["I_1"]);
    const calls = h.requests.map((http) => JSON.stringify(http.body));
    expect(calls.filter((body) => body.includes("TaskItems"))).toHaveLength(5);
    expect(calls.filter((body) => body.includes("TaskIterations"))).toHaveLength(3);
    expect(calls.filter((body) => body.includes('"id":"I_1"'))).toHaveLength(2);
    expect(calls.every((body) => !body.includes("mutation"))).toBe(true);
  });

  it("pins actual UTF-8 SHA-256 hashes and detects title/body/native dependency edits", async () => {
    expect(sha256ContentHasher.sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const h = setup();
    const deps = { reader: h.reader, hasher: sha256ContentHasher };
    const first = await importTask(deps, request);
    expect(await importTask(deps, request)).toEqual(first);
    const root = h.issues[0];
    if (root === undefined) throw new Error("missing fixture");
    root.body += " Thêm tiêu chí nghiệm thu.";
    const edited = await importTask(deps, request);
    expect(edited.snapshots[0]?.contentHash).not.toBe(first.snapshots[0]?.contentHash);
    root.blockedBy = ["I_2"];
    expect((await importTask(deps, request)).snapshots[0]?.contentHash).not.toBe(
      edited.snapshots[0]?.contentHash,
    );
  });

  it.each(["TaskItems", "TaskIterations", "TaskIssue"])(
    "refuses incomplete, malformed and repeated-cursor %s reads",
    async (stage) => {
      for (const [fault, code] of [
        ["truncate", "INCOMPLETE_CONNECTION"],
        ["repeat-cursor", "INVALID_PAGINATION"],
        ["null-cursor", "INVALID_PAGINATION"],
        ["null-node", "INVALID_RESPONSE"],
        ["malformed", "INVALID_RESPONSE"],
        ["graphql-errors", "GRAPHQL_ERRORS"],
      ]) {
        const h = setup(fault, stage);
        await expect(
          importTask({ reader: h.reader, hasher: sha256ContentHasher }, request),
        ).rejects.toMatchObject({ code });
      }
      const h = setup("", stage, 1);
      await expect(
        stage === "TaskIssue" ? h.reader.issue("I_1") : h.reader.items("PVT_1"),
      ).rejects.toMatchObject({ code: "PAGINATION_LIMIT" });
    },
  );

  it.each([
    ["identity", "REMOTE_IDENTITY_MISMATCH"],
    ["changed", "REMOTE_CHANGED_DURING_READ"],
  ])("refuses %s Issue evidence", async (fault, code) => {
    await expect(setup(fault, "TaskIssue").reader.issue("I_1")).rejects.toMatchObject({ code });
  });

  it("refuses a dependency cycle returned by native blockedBy", async () => {
    const h = setup();
    h.issues[1]?.blockedBy.push("I_1");
    await expect(
      importTask({ reader: h.reader, hasher: sha256ContentHasher }, request),
    ).rejects.toMatchObject({ code: "DEPENDENCY_CYCLE" });
  });

  it("passes read-only queries and variables through gh stdin", async () => {
    const h = setup();
    const calls: string[][] = [];
    const transport = createGhApiTransport({
      run: async (args, stdin) => {
        calls.push([...args]);
        const response = await h.transport.send({
          method: "POST",
          path: "graphql",
          body: JSON.parse(stdin ?? "null") as unknown,
        });
        return { code: 0, timedOut: false, stdout: `HTTP/2.0 200 OK\n\n${response.body}` };
      },
    });
    const client = createGithubRestClient({
      transport,
      sleep: () => Promise.resolve(),
      now: () => 0,
      random: () => 0,
    });
    await createGithubTaskReader(client).issue("I_1");
    expect(calls).toHaveLength(2);
    expect(
      calls.every(
        (args) =>
          JSON.stringify(args) ===
          JSON.stringify(["api", "--include", "-X", "POST", "graphql", "--input", "-"]),
      ),
    ).toBe(true);
  });
});
