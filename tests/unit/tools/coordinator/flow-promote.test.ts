import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, type Context } from "../../../../tools/coordinator/flow.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

// A fake gh answers the Project snapshot and the single-Issue query (told apart by their text);
// a write is any `gh project item-edit`. No real Issue is ever touched.
interface Fake {
  number: number;
  status: string;
  priority?: string;
  workType?: string;
  role?: string | null;
  blockers?: readonly { number: number; state: string }[];
}
const key = (n: number) => `OMI-${String(n).padStart(3, "0")}`;
const bodyOf = (n: number) =>
  `## Acceptance criteria\n- [ ] one\n<!-- omi-squad:plan-key=${key(n)} -->`;
const select = (name: string | null | undefined) => (name == null ? null : { name });
const text = (c: Command) => [c.file, ...c.args].join(" ");

function context(issues: Fake[]) {
  const seen: Command[] = [];
  const fields = (i: Fake) => ({
    status: select(i.status),
    priority: select(i.priority ?? "P1"),
    workType: select(i.workType ?? "Task"),
    workflow: select("feature"),
    role: select(i.role === undefined ? "Developer" : i.role),
    area: select("domain"),
    planKey: { text: key(i.number) },
  });
  const blockedBy = (i: Fake) => ({
    totalCount: (i.blockers ?? []).length,
    nodes: i.blockers ?? [],
  });
  const snapshot = {
    organization: {
      projectV2: {
        title: "Project",
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: issues.map((i) => ({
            ...fields(i),
            content: {
              __typename: "Issue",
              number: i.number,
              title: `[${key(i.number)}] t`,
              state: "OPEN",
              body: bodyOf(i.number),
              milestone: { title: "M1 — Core foundation" },
              blockedBy: blockedBy(i),
            },
          })),
        },
      },
    },
    repository: { pullRequests: { nodes: [] } },
  };
  const issueData = (number: number) => {
    const i = issues.find((x) => x.number === number);
    return {
      organization: {
        projectV2: {
          id: "project",
          field: {
            id: "status",
            options: [
              { id: "o1", name: "Backlog" },
              { id: "o2", name: "Ready" },
            ],
          },
        },
      },
      repository: {
        issue: i && {
          state: "OPEN",
          body: bodyOf(i.number),
          blockedBy: blockedBy(i),
          comments: { nodes: [] },
          timelineItems: { nodes: [] },
          labels: { nodes: [], pageInfo: { hasNextPage: false } },
          projectItems: { nodes: [{ id: "item", project: { id: "project" }, ...fields(i) }] },
        },
      },
    };
  };
  const run: Runner = (command) => {
    seen.push(command);
    let data: unknown = {};
    if (command.file === "gh" && command.input?.includes("pullRequests")) data = snapshot;
    else if (command.file === "gh" && command.input?.includes("projectItems")) {
      const variables = JSON.parse(command.input) as { variables: { number: number } };
      data = issueData(variables.variables.number);
    }
    return Promise.resolve({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
  };
  const target = { viaWslExe: true, distro: "Ubuntu-24.04", repoDir: "/home/u/omi" };
  const ctx: Context = { run, target, hostCwd: "C:\\omi", isWindows: true };
  return { ctx, seen };
}

const writes = (seen: Command[]) => seen.filter((c) => c.args.includes("item-edit"));
const errors = () => vi.mocked(console.error).mock.calls.flat().join("\n");
const logs = () => vi.mocked(console.log).mock.calls.flat().join("\n");

describe("flow promote", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("promote N moves a Backlog Issue to Ready; a rerun reports done: without writing", async () => {
    const first = context([
      { number: 70, status: "Backlog", blockers: [{ number: 9, state: "CLOSED" }] },
    ]);
    expect(await main(["promote", "70"], first.ctx)).toBe(0);
    expect(writes(first.seen)).toHaveLength(1);
    expect(text(writes(first.seen)[0] as Command)).toContain("--single-select-option-id o2");

    const again = context([{ number: 70, status: "Ready" }]);
    expect(await main(["promote", "70"], again.ctx)).toBe(0);
    expect(writes(again.seen)).toHaveLength(0);
    expect(logs()).toContain("done:");
  });

  it.each([
    ["an open blocker", { blockers: [{ number: 8, state: "OPEN" }] }, /blocked by #8/],
    ["an Epic", { workType: "Epic" }, /is an Epic/],
    ["not Backlog", { status: "In Progress" }, /not Backlog/],
    ["a failing readiness gate", { role: null }, /missing Role/],
  ] as const)("promote N refuses %s and writes nothing", async (_name, over, reason) => {
    const { ctx, seen } = context([{ number: 70, status: "Backlog", ...over }]);
    expect(await main(["promote", "70"], ctx)).toBe(1);
    expect(errors()).toContain("refused:");
    expect(errors()).toMatch(reason);
    expect(writes(seen)).toHaveLength(0);
  });

  it("promote without N picks the first Backlog Issue in priority order", async () => {
    const { ctx, seen } = context([
      { number: 72, status: "Backlog", priority: "P2" },
      { number: 71, status: "Backlog", priority: "P1", blockers: [{ number: 1, state: "OPEN" }] },
      { number: 73, status: "Backlog", priority: "P1" },
      { number: 74, status: "Backlog", priority: "P0", workType: "Epic" },
    ]);
    expect(await main(["promote"], ctx)).toBe(0);
    expect(logs()).toContain("promote 73:");
    expect(writes(seen)).toHaveLength(1);
  });

  it("promote without N reports no candidate, exits 0 and writes nothing", async () => {
    const { ctx, seen } = context([
      { number: 71, status: "Backlog", blockers: [{ number: 1, state: "OPEN" }] },
      { number: 72, status: "Ready" },
    ]);
    expect(await main(["promote"], ctx)).toBe(0);
    expect(logs()).toContain("no Backlog Issue");
    expect(writes(seen)).toHaveLength(0);
  });

  it("--dry-run prints the write it would do and performs none", async () => {
    const { ctx, seen } = context([{ number: 70, status: "Backlog" }]);
    expect(await main(["promote", "70", "--dry-run"], ctx)).toBe(0);
    expect(logs()).toContain("would run: gh project item-edit");
    expect(writes(seen)).toHaveLength(0);
  });
});
