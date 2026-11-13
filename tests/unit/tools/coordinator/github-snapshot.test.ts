import { describe, expect, it } from "vitest";
import { COORDINATOR_LOGIN } from "../../../../tools/coordinator/coordinator-settings.ts";
import {
  classifyReview,
  findMismatches,
  groupByStatus,
  ignoredVerdictWarnings,
  latestAgentReview,
  linkedIssue,
  parseSnapshotPage,
  partitionReady,
  SNAPSHOT_QUERY,
  summarizeChecks,
  type CheckContext,
  type ProjectItem,
} from "../../../../tools/coordinator/github-snapshot.ts";

function item(over: Partial<ProjectItem> & { number: number }): ProjectItem {
  return {
    kind: "Issue",
    title: `[OMI-${String(over.number)}] task`,
    state: "OPEN",
    status: "Ready",
    priority: "P1",
    workType: "Task",
    planKey: `OMI-${String(over.number).padStart(3, "0")}`,
    body: "",
    workflow: null,
    role: null,
    area: null,
    milestone: "M1 — Core foundation",
    blockers: [],
    blockersTruncated: false,
    ...over,
  };
}

describe("partitionReady", () => {
  it("treats a task as unblocked only when every blocker is closed", () => {
    const { unblocked, blocked } = partitionReady([
      item({ number: 1, blockers: [{ number: 9, state: "CLOSED" }] }),
      item({
        number: 2,
        blockers: [
          { number: 9, state: "CLOSED" },
          { number: 8, state: "OPEN" },
        ],
      }),
    ]);
    expect(unblocked.map((r) => r.item.number)).toEqual([1]);
    expect(blocked).toEqual([expect.objectContaining({ openBlockers: [8] })]);
  });

  it("counts a truncated blocker list as blocked even if the fetched page is all closed", () => {
    const { unblocked, blocked } = partitionReady([
      item({ number: 1, blockers: [{ number: 9, state: "CLOSED" }], blockersTruncated: true }),
    ]);
    expect(unblocked).toEqual([]);
    expect(blocked.map((r) => r.item.number)).toEqual([1]);
  });

  it("excludes Epics, closed Issues, PR items and non-Ready statuses", () => {
    const { unblocked, blocked } = partitionReady([
      item({ number: 1, workType: "Epic" }),
      item({ number: 2, state: "CLOSED" }),
      item({ number: 3, status: "Backlog" }),
      item({ number: 4, kind: "PullRequest" }),
      item({ number: 5, status: "In Progress" }),
    ]);
    expect([...unblocked, ...blocked]).toEqual([]);
  });

  it("orders by priority, then milestone, then Issue number; missing priority last", () => {
    const { unblocked } = partitionReady([
      item({ number: 7, priority: null, milestone: "M0 — Feasibility" }),
      item({ number: 6, priority: "P1", milestone: "M0 — Feasibility" }),
      item({ number: 5, priority: "P0", milestone: "M2 — Execution" }),
      item({ number: 4, priority: "P0", milestone: "M1 — Core foundation" }),
      item({ number: 3, priority: "P0", milestone: "M1 — Core foundation" }),
    ]);
    expect(unblocked.map((r) => r.item.number)).toEqual([3, 4, 5, 6, 7]);
  });
});

describe("groupByStatus", () => {
  it("keeps board order, lists empty statuses, puts unknown after known and (none) last", () => {
    const groups = groupByStatus([
      item({ number: 1, status: null }),
      item({ number: 2, status: "Done" }),
      item({ number: 3, status: "Someday" }),
      item({ number: 4, status: "Backlog" }),
    ]);
    expect(groups.map((g) => g.status)).toEqual([
      "Backlog",
      "Ready",
      "In Progress",
      "In Review",
      "Waiting Approval",
      "Waiting Resource",
      "Blocked",
      "Done",
      "Someday",
      "(none)",
    ]);
    expect(groups.flatMap((g) => g.items.map((i) => i.number)).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("summarizeChecks", () => {
  const check = (name: string, state: CheckContext["state"]): CheckContext => ({ name, state });
  const required = ["check", "issue-link"];

  it("is pass only when every required check passed", () => {
    expect(
      summarizeChecks([check("check", "pass"), check("issue-link", "pass")], required),
    ).toEqual({ overall: "pass", failing: [], pending: [], missingRequired: [] });
  });

  it("fails on any failing check, required or not", () => {
    const s = summarizeChecks(
      [check("check", "pass"), check("issue-link", "pass"), check("extra", "fail")],
      required,
    );
    expect(s.overall).toBe("fail");
    expect(s.failing).toEqual(["extra"]);
  });

  it("is pending, not pass, when a required check never reported", () => {
    const s = summarizeChecks([check("check", "pass")], required);
    expect(s).toMatchObject({ overall: "pending", missingRequired: ["issue-link"] });
  });

  it("is pending while a check runs and none when nothing reported", () => {
    expect(summarizeChecks([check("check", "pending")], required).overall).toBe("pending");
    expect(summarizeChecks([], required).overall).toBe("none");
  });
});

describe("classifyReview", () => {
  const head = "b0ab3b3b1aa20def858c14f954303c6cc63178bc";
  const verdict = (v: string, sha: string, author: string | null = COORDINATOR_LOGIN) => ({
    author,
    body: `## Independent agent review\n\n**VERDICT:** ${v} · **REVIEWED_HEAD:** \`${sha}\``,
  });
  const note = (body: string) => ({ author: COORDINATOR_LOGIN, body });

  it("marks the agent verdict current only if it names the PR head", () => {
    expect(
      classifyReview({ reviewDecision: null, headRefOid: head, comments: [verdict("PASS", head)] })
        .agent,
    ).toEqual({ verdict: "PASS", head, current: true, carriedFrom: null });
    expect(
      classifyReview({
        reviewDecision: null,
        headRefOid: head,
        comments: [verdict("PASS", "1111111")],
      }).agent?.current,
    ).toBe(false);
  });

  it("uses the latest verdict comment and ignores other comments", () => {
    const r = classifyReview({
      reviewDecision: "APPROVED",
      headRefOid: head,
      comments: [verdict("FAIL", "1111111"), note("looks fine"), verdict("PASS", "b0ab3b3")],
    });
    expect(r).toEqual({
      native: "APPROVED",
      agent: { verdict: "PASS", head: "b0ab3b3", current: true, carriedFrom: null },
      ignoredVerdictAuthors: [],
    });
    expect(
      classifyReview({ reviewDecision: null, headRefOid: head, comments: [note("hi")] }).agent,
    ).toBe(null);
  });

  it("ignores VERDICT comments from any account but the Coordinator and names them", () => {
    const r = classifyReview({
      reviewDecision: null,
      headRefOid: head,
      comments: [
        verdict("FAIL", head),
        verdict("PASS", head, "someone-else"),
        verdict("PASS", head, null),
        verdict("PASS", head, "someone-else"),
      ],
    });
    expect(r.agent).toEqual({ verdict: "FAIL", head, current: true, carriedFrom: null });
    expect(r.ignoredVerdictAuthors).toEqual(["someone-else", "(deleted account)"]);
    expect(latestAgentReview([verdict("PASS", head, "someone-else")])).toBe(null);
  });

  it("gives status.ts one Attention line per PR with an ignored VERDICT", () => {
    const review = (authors: string[]) => ({
      native: null,
      agent: null,
      ignoredVerdictAuthors: authors,
    });
    expect(
      ignoredVerdictWarnings([
        { number: 70, review: review(["someone-else", "bot"]) },
        { number: 71, review: review([]) },
      ]),
    ).toEqual([
      `PR #70: ignored VERDICT comment from someone-else, bot (only ${COORDINATOR_LOGIN} counts)`,
    ]);
  });
});

describe("linkedIssue", () => {
  it("reads only an `Issue: #N` line, not a mention inside text", () => {
    expect(linkedIssue("Summary\nIssue: #61\n")).toBe(61);
    expect(linkedIssue("See Issue: #61 later")).toBe(null);
    expect(linkedIssue("Fixes #61")).toBe(null);
  });
});

describe("findMismatches", () => {
  it("reports Done-but-open and closed-but-not-Done Issues", () => {
    expect(
      findMismatches([
        item({ number: 1, status: "Done", state: "OPEN" }),
        item({ number: 2, status: "Ready", state: "CLOSED" }),
        item({ number: 3, status: "Done", state: "CLOSED" }),
      ]),
    ).toEqual(["#1 is Done but open", "#2 is closed but Status is Ready"]);
  });
});

describe("SNAPSHOT_QUERY", () => {
  it("reads up to 100 blockers per Issue so 21 to 100 closed blockers are not truncated", () => {
    expect(SNAPSHOT_QUERY).toContain("blockedBy(first: 100)");
  });
});

describe("parseSnapshotPage", () => {
  const page = {
    organization: {
      projectV2: {
        title: "omi-squad delivery",
        items: {
          pageInfo: { hasNextPage: true, endCursor: "abc" },
          nodes: [
            {
              status: { name: "Ready" },
              priority: { name: "P0" },
              workType: { name: "Task" },
              planKey: { text: "OMI-006" },
              content: {
                __typename: "Issue",
                body: "",
                number: 7,
                title: "[OMI-006] PoC GitHub capability",
                state: "OPEN",
                milestone: { title: "M0 — Feasibility" },
                blockedBy: { totalCount: 1, nodes: [{ number: 2, state: "CLOSED" }] },
                comments: {
                  nodes: [{ author: { login: COORDINATOR_LOGIN }, body: "**WAITING-PO:** x" }],
                },
              },
            },
            { status: null, priority: null, workType: null, planKey: null, content: null },
            {
              status: null,
              priority: null,
              workType: null,
              planKey: null,
              content: { __typename: "DraftIssue", title: "idea" },
            },
          ],
        },
      },
    },
    repository: {
      pullRequests: {
        nodes: [
          {
            number: 62,
            title: "t",
            isDraft: false,
            headRefName: "task/omi-050-x",
            headRefOid: "abc1234",
            baseRefName: "develop",
            body: "Issue: #61",
            reviewDecision: null,
            mergeStateStatus: "CLEAN",
            comments: {
              nodes: [
                { author: { login: COORDINATOR_LOGIN }, body: "review" },
                { author: null, body: "from a deleted account" },
              ],
            },
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          {
                            __typename: "CheckRun",
                            name: "check",
                            status: "COMPLETED",
                            conclusion: "SKIPPED",
                          },
                          { __typename: "StatusContext", context: "ci/x", state: "PENDING" },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  };

  it("parses items, skips invisible content, and maps check states", () => {
    const p = parseSnapshotPage(page);
    expect(p.nextCursor).toBe("abc");
    expect(p.items.map((i) => [i.kind, i.number])).toEqual([
      ["Issue", 7],
      ["DraftIssue", null],
    ]);
    expect(p.items[0]).toMatchObject({ planKey: "OMI-006", blockersTruncated: false });
    expect(p.items[0]?.comments).toEqual([
      { author: COORDINATOR_LOGIN, body: "**WAITING-PO:** x" },
    ]);
    expect(p.pulls?.[0]?.checks).toEqual([
      { name: "check", state: "pass" },
      { name: "ci/x", state: "pending" },
    ]);
    expect(p.pulls?.[0]?.comments).toEqual([
      { author: COORDINATOR_LOGIN, body: "review" },
      { author: null, body: "from a deleted account" },
    ]);
  });

  it("fails loudly with a path when the API shape changes", () => {
    const broken = structuredClone(page);
    (
      broken.organization.projectV2.items.nodes[0] as { content: { number: unknown } }
    ).content.number = "7";
    expect(() => parseSnapshotPage(broken)).toThrow(/items\[0\]\.content\.number/);
  });

  it("reports a missing Project instead of an empty board", () => {
    expect(() => parseSnapshotPage({ organization: { projectV2: null } })).toThrow(/not found/);
  });
});
