import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  main,
  pickProfileCommand,
  referencingPulls,
  type Context,
} from "../../../../tools/coordinator/flow.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

const BRANCH = "task/omi-051-harden-coordinator-tooling";

/** Fake gh/git/wsl.exe: both checkouts are on the merged task branch, clean. */
function fakeContext(): { ctx: Context; seen: Command[] } {
  const seen: Command[] = [];
  const run: Runner = (command) => {
    seen.push(command);
    const args = command.file === "wsl.exe" ? gitArgs(command) : command.args;
    const [sub, flag] = args;
    let stdout = "";
    if (isRunsListing(command)) stdout = "@@now\n2000000000\n@@root\n@@archive\n";
    else if (sub === "worktree") stdout = "worktree /home/u/omi\0branch refs/heads/develop\0\0";
    else if (sub === "remote") stdout = "https://github.com/omi-hub-services/omi.git\n";
    else if (sub === "rev-parse") stdout = flag === "--abbrev-ref" ? `${BRANCH}\n` : "abc\n";
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
  const target = { viaWslExe: true, distro: "Ubuntu-24.04", repoDir: "/home/u/omi" };
  return { ctx: { run, target, hostCwd: "C:\\omi", isWindows: true }, seen };
}

/** git argv of a single-command WSL payload (`git a b c`); a chained payload keeps its `&&`. */
const gitArgs = (c: Command) => (c.args.at(-1) ?? "").split(" ").slice(1);

/** The read-only ~/omi-runs listing that follows the branch cleanup (OMI-056). */
const isRunsListing = (c: Command) => (c.args.at(-1) ?? "").includes("@@now");

const READ_ONLY_GIT = new Set(["remote", "rev-parse", "status", "merge-base", "worktree", "-d"]);
const text = (c: Command) => [c.file, ...c.args].join(" ");

describe("referencingPulls", () => {
  /** A CrossReferencedEvent source as the Issue timeline query returns it. */
  const source = (number: number, nameWithOwner: string) => ({
    number,
    merged: true,
    mergedAt: "2026-11-10T10:00:00Z",
    baseRefName: "develop",
    headRefOid: "abc1234",
    body: "Issue: #65",
    repository: { nameWithOwner },
    comments: { nodes: [{ author: { login: "minibox-claude-code" }, body: "VERDICT" }] },
  });
  const timeline = (...sources: unknown[]) => ({
    timelineItems: { nodes: sources.map((s) => ({ source: s })) },
  });

  it("keeps only PRs of this repository, never a PR elsewhere that links the Issue", () => {
    const pulls = referencingPulls(
      timeline(
        source(64, "omi-hub-services/omi"),
        source(64, "someone/omi-fork"),
        {}, // an Issue cross-reference parses to an empty object
        source(66, "omi-hub-services/other"),
      ),
    );
    expect(pulls).toEqual([
      {
        number: 64,
        merged: true,
        mergedAt: "2026-11-10T10:00:00Z",
        baseRefName: "develop",
        headRefOid: "abc1234",
        body: "Issue: #65",
        comments: [{ author: "minibox-claude-code", body: "VERDICT" }],
      },
    ]);
  });

  it("fails loudly when the repository of a PR is missing from the response", () => {
    const noRepo = { ...source(64, "omi-hub-services/omi"), repository: undefined };
    expect(() => referencingPulls(timeline(noRepo))).toThrow(/source\.repository/);
  });
});

describe("flow cleanup", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--dry-run only reads: no fetch, no switch, no merge, no branch deletion", async () => {
    const { ctx, seen } = fakeContext();
    expect(await cleanup(ctx, BRANCH, true)).toBe(true);
    expect(seen.map(text).join("\n")).not.toMatch(/fetch|switch|merge --ff-only|branch -D/);
    for (const c of seen.filter((x) => !isRunsListing(x))) {
      if ((c.args.at(-1) ?? "").startsWith("test -d")) continue;
      const args = c.file === "wsl.exe" ? gitArgs(c) : c.args;
      expect(args.includes("&&"), text(c)).toBe(false);
      expect(READ_ONLY_GIT.has(args[0] ?? ""), text(c)).toBe(true);
    }
    // ...while it still reports what a real run would do on both sides.
    const printed = vi.mocked(console.log).mock.calls.map((a) => String(a[0]));
    expect(printed.filter((l) => l.includes("would run") && l.includes("branch -D"))).toHaveLength(
      2,
    );
  });

  it("a real run fetches first on both sides, then deletes the branch", async () => {
    const { ctx, seen } = fakeContext();
    expect(await cleanup(ctx, BRANCH, false)).toBe(true);
    const lines = seen.map(text);
    expect(lines.find((line) => line.includes("git fetch"))).toMatch(
      /^wsl\.exe .* bash -lc git fetch --prune --quiet origin$/,
    );
    expect(lines).toContain("git fetch --prune --quiet origin");
    expect(lines.filter((l) => l.includes("branch -D"))).toHaveLength(2);
  });
});

describe("linked-worktree cleanup", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  function worktreeContext(
    options: {
      changes?: string;
      mainBranch?: string;
      absent?: boolean;
      branchGone?: boolean;
      fail?: string;
    } = {},
  ) {
    const seen: Command[] = [];
    let removed = options.absent ?? false;
    let branchGone = options.branchGone ?? false;
    const run: Runner = (command) => {
      seen.push(command);
      const payload = command.args.at(-1) ?? "";
      let stdout = "";
      let code = 0;
      if (payload.startsWith("test -d")) code = removed ? 1 : 0;
      else if (payload.includes("worktree list")) {
        stdout = `worktree /main repo\0branch refs/heads/${options.mainBranch ?? "develop"}\0\0`;
        if (!removed && !branchGone)
          stdout += `worktree /task repo\0branch refs/heads/${BRANCH}\0\0`;
      } else if (isRunsListing(command)) stdout = "@@now\n2000000000\n@@root\n@@archive\n";
      else if (payload.includes("worktree remove")) {
        removed = true;
        branchGone = true;
      } else if (payload.includes("branch -d")) branchGone = true;
      else if (payload.includes("status --porcelain --untracked-files=all"))
        stdout = options.changes ?? "";
      else if (payload.includes("rev-parse --verify")) {
        code = branchGone ? 1 : 0;
        stdout = "abc\n";
      } else if (payload.includes("rev-parse")) stdout = `${BRANCH}\n`;
      if (options.fail && payload.includes(options.fail)) code = 1;
      return Promise.resolve({ code, stdout, stderr: code ? "failed" : "" });
    };
    const ctx: Context = {
      run,
      target: { viaWslExe: true, distro: "Ubuntu", repoDir: "/task repo" },
      hostCwd: "/unused",
      isWindows: false,
    };
    return { ctx, seen };
  }

  it("detaches and safely deletes before removal, fast-forwards main develop, then reads logs", async () => {
    const { ctx, seen } = worktreeContext();
    expect(await cleanup(ctx, BRANCH, false)).toBe(true);
    const write = seen.find((c) => text(c).includes("worktree remove"));
    expect(write?.args).toContain("/main repo");
    expect(write?.args.at(-1)).toBe(
      `git -C '/task repo' fetch origin && git -C '/task repo' switch --detach origin/develop && git -C '/task repo' branch -d ${BRANCH} && git -C '/main repo' worktree remove -- '/task repo' && git -C '/main repo' merge --ff-only origin/develop`,
    );
    expect(seen.at(-1)?.args).toContain("/main repo");
    expect(isRunsListing(seen.at(-1) ?? { file: "", args: [] })).toBe(true);
    expect(seen.map(text).join("\n")).not.toMatch(/branch -D|--force/);
    seen.length = 0;
    expect(await cleanup(ctx, BRANCH, false)).toBe(false);
    expect(seen.map(text).join("\n")).not.toMatch(/fetch|worktree remove|branch -d/);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("refused:");
  });

  it.each([" M tracked.ts\n", "?? prompt.md\n"])(
    "refuses changes with the file list: %s",
    async (changes) => {
      const { ctx, seen } = worktreeContext({ changes });
      expect(await cleanup(ctx, BRANCH, false)).toBe(false);
      expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(changes.trimEnd());
      expect(seen.map(text).join("\n")).not.toMatch(/fetch|worktree remove|branch -d|@@now/);
      expect(seen.map(text).join("\n")).toContain(":(exclude)**/node_modules/**");
    },
  );

  it("does not fast-forward a main checkout on another task", async () => {
    const { ctx, seen } = worktreeContext({ mainBranch: "task/omi-063-other" });
    expect(await cleanup(ctx, BRANCH, false)).toBe(true);
    expect(seen.map(text).join("\n")).not.toContain("merge --ff-only");
    expect(seen.find((c) => text(c).includes("worktree remove"))?.args.at(-1)).toBe(
      `git -C '/task repo' fetch origin && git -C '/task repo' switch --detach origin/develop && git -C '/task repo' branch -d ${BRANCH} && git -C '/main repo' worktree remove -- '/task repo'`,
    );
  });

  it("dry-run prints removal and safe deletion but only reads", async () => {
    const { ctx, seen } = worktreeContext();
    expect(await cleanup(ctx, BRANCH, true)).toBe(true);
    expect(seen.map(text).join("\n")).not.toMatch(/fetch|worktree remove|branch -d/);
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("worktree remove");
    expect(output).toContain("branch -d");
  });

  it.each([false, true])(
    "refuses a missing worktree with a remaining branch (dry-run=%s)",
    async (dryRun) => {
      const { ctx, seen } = worktreeContext({ absent: true });
      expect(await cleanup(ctx, BRANCH, dryRun)).toBe(false);
      expect(seen).toHaveLength(1);
      expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain("done:");
      const error = vi.mocked(console.error).mock.calls.flat().join("\n");
      expect(error).toContain("refused:");
      expect(error).toContain(`git -C <main-checkout> branch -d ${BRANCH}`);
    },
  );

  it("an absent branch is done without deleting anything", async () => {
    const { ctx, seen } = worktreeContext({ branchGone: true });
    expect(await cleanup(ctx, BRANCH, true)).toBe(true);
    expect(seen.map(text).join("\n")).not.toMatch(/worktree remove|branch -d/);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("already gone");
  });

  it("a failed worktree command skips log retention", async () => {
    const { ctx, seen } = worktreeContext({ fail: "worktree remove" });
    expect(await cleanup(ctx, BRANCH, false)).toBe(false);
    expect(seen.some(isRunsListing)).toBe(false);
  });
});

// The quota collector returns no readings; --probe permits unknown profiles without
// invoking any real CLI in these tests.
describe("flow pick-profile", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  function context(
    workflow: string | null = "feature",
    labels: string[] = [],
    complexity: string | null = null,
  ) {
    const { ctx, seen } = fakeContext();
    const run: Runner = (command) => {
      seen.push(command);
      const stdout =
        command.file === "gh"
          ? JSON.stringify({
              data: {
                organization: {
                  projectV2: { id: "project", field: { id: "status", options: [] } },
                },
                repository: {
                  issue: {
                    state: "OPEN",
                    body: "## Acceptance criteria\n- [ ] one\n  - [ ] nested\n- [x] two\n",
                    comments: { nodes: [] },
                    timelineItems: { nodes: [] },
                    labels: {
                      nodes: labels.map((name) => ({ name })),
                      pageInfo: { hasNextPage: false },
                    },
                    projectItems: {
                      nodes: [
                        {
                          id: "item",
                          project: { id: "project" },
                          complexity: complexity === null ? null : { name: complexity },
                          workflow: workflow === null ? null : { name: workflow },
                          workType: { name: "Task" },
                          area: { name: "runtime" },
                          priority: { name: "P1" },
                        },
                      ],
                    },
                  },
                },
              },
            })
          : JSON.stringify({ kind: "now", now: 1794290000 });
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    };
    return { ctx: { ...ctx, run }, seen };
  }

  it.each([
    ["set-status", "96", "Ready"],
    ["set-status", "96", "In Progress"],
    ["start-branch", "96", "a-task"],
  ])("%s refuses incomplete Issue data before any write or git probe", async (...argv) => {
    const { ctx, seen } = context();
    expect(await main(argv, ctx)).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.file).toBe("gh");
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("refused:");
    expect(output).toContain("missing Plan Key");
    expect(output).toContain("missing Role");
  });

  it("uses the manual field before a conflicting label and reports explicit settings", async () => {
    const { ctx } = context("docs", ["complexity:low"], "high");
    expect(await pickProfileCommand(ctx, 93, "codex", true, true)).toBe(0);
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
      complexity: "high",
      reason: "field complexity:high",
      chosen: [{ model: "gpt-6.1-sol", effort: "high" }],
    });
  });

  it("prints model advice for both selected tools and reviewer without changing quota choices", async () => {
    const { ctx, seen } = context();
    expect(await pickProfileCommand(ctx, 93, "claude+codex-live", true)).toBe(0);
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("pick-profile 93: claude ggtintran");
    expect(output).toContain("pick-profile 93: codex ggtintran");
    expect(output).toContain(
      "claude model: claude-opus-5-5 effort: high (complexity high: runtime with live tests)",
    );
    expect(output).toContain("codex model: gpt-6.1-sol effort: high");
    expect(output).toContain("reviewer: opus high (complexity high: runtime with live tests)");
    const query = seen.find((command) => command.file === "gh")?.input ?? "";
    for (const field of ["Workflow", "Work Type", "Area", "Priority"])
      expect(query).toContain(field);
  });

  it.each([
    ["docs", [], "low", "sonnet"],
    [null, [], "medium", "sonnet"],
    ["research", ["complexity:low"], "low", "sonnet"],
  ] as const)(
    "adds structured JSON advice for %s",
    async (workflow, labels, complexity, reviewer) => {
      const { ctx } = context(workflow, [...labels]);
      expect(await pickProfileCommand(ctx, 93, "codex", true, true)).toBe(0);
      const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        complexity,
        reason: expect.stringMatching(/.+/) as unknown,
        chosen: [
          {
            tool: "codex",
            profile: "ggtintran",
            model: "gpt-6.1-sol",
            effort: complexity,
            complexity,
            reason: expect.stringMatching(/.+/) as unknown,
          },
        ],
        reviewer: {
          model: reviewer,
          effort: complexity,
          complexity,
          reason: expect.stringMatching(/.+/) as unknown,
        },
      });
    },
  );

  it.each([
    ["feature", "claude-sonnet-5-5"],
    ["research", "claude-opus-5-5"],
  ])("checks weekly quota for its inferred %s model without --model", async (workflow, model) => {
    const { ctx } = context(workflow);
    const run: Runner = (command) =>
      command.file === "gh"
        ? ctx.run(command)
        : Promise.resolve({
            code: 0,
            stderr: "",
            stdout: [
              { kind: "now", now: 1794290000 },
              ...["ggtintran", "minibox"].map((profile) => ({
                kind: "usage",
                profile,
                usage: {
                  five_hour: { utilization: 10, resets_at: "2026-12-01T00:00:00Z" },
                  seven_day: { utilization: 10, resets_at: "2026-12-01T00:00:00Z" },
                  limits: [
                    {
                      kind: "weekly_scoped",
                      model,
                      percent: 99,
                      resets_at: "2026-12-01T00:00:00Z",
                    },
                  ],
                },
              })),
            ]
              .map((o) => JSON.stringify(o))
              .join("\n"),
          });
    expect(await pickProfileCommand({ ...ctx, run }, 93, "claude", false, true)).toBe(1);
    const output = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])) as {
      reason: string;
    };
    expect(output.reason).toContain(`${model} weekly 1% left`);
  });

  it("keeps quota refusals after reading the Issue to choose its model", async () => {
    const { ctx, seen } = context();
    expect(await pickProfileCommand(ctx, 93, "claude", false, true)).toBe(1);
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
    });
    expect(seen.filter((command) => command.file === "gh")).toHaveLength(1);
  });
});

describe("release review command wiring", () => {
  const head = "a".repeat(40);
  const review = (deferred: boolean) =>
    `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\`\nAC-1: ${deferred ? "deferred — tag after merge" : "met — tag published"}`;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  function context(workflow: string, state: string, checkConclusion: string | null = "SUCCESS") {
    const { ctx, seen } = fakeContext();
    const run: Runner = (command) => {
      seen.push(command);
      let stdout = "";
      if (command.args[1] === "graphql") {
        const pullRequest = {
          author: { login: "minibox-claude-code" },
          reviews: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                author: { login: "ttin-omihub", __typename: "User" },
                state: "APPROVED",
                commit: { oid: head },
              },
            ],
          },
          number: 314,
          title: "Release",
          state,
          isDraft: false,
          headRefName: "develop",
          baseRefName: "main",
          headRefOid: head,
          body: "Issue: #311",
          reviewDecision: "APPROVED",
          mergeStateStatus: "CLEAN",
          mergeCommit: null,
          comments: { nodes: [{ author: { login: "minibox-claude-code" }, body: review(true) }] },
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
                          conclusion: checkConclusion,
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        };
        stdout = JSON.stringify({
          data: {
            organization: { projectV2: { id: "project", field: { id: "status", options: [] } } },
            repository: {
              pullRequest,
              issue: {
                state: "OPEN",
                // An implementation map without sensitive paths: no `Security:` section is needed.
                body: "## Acceptance criteria\n- [ ] tag published\n\n## Implementation map\n- docs/notes.md\n",
                comments: { nodes: [] },
                timelineItems: { nodes: [] },
                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                projectItems: {
                  nodes: [{ id: "item", project: { id: "project" }, workflow: { name: workflow } }],
                },
              },
            },
          },
        });
      } else if (command.args[1] === "user") stdout = "minibox-claude-code";
      else if (command.args[1]?.includes("rules/branches/")) stdout = "[]";
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    };
    return { ctx: { ...ctx, run }, seen };
  }

  it.each(["FAILURE", "CANCELLED", "NEUTRAL", null])(
    "refuses a passing review without a green head check (%s)",
    async (conclusion) => {
      const dir = mkdtempSync(join(tmpdir(), "omi-review-check-"));
      try {
        const file = join(dir, "review.md");
        writeFileSync(file, review(false));
        const { ctx, seen } = context("feature", "OPEN", conclusion);
        expect(await main(["review-comment", "314", "--file", file], ctx)).toBe(1);
        expect(seen.some((c) => c.args[0] === "pr" && c.args[1] === "comment")).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["release", "OPEN", true, 0],
    ["feature", "OPEN", true, 1],
    ["release", "MERGED", false, 0],
    ["feature", "MERGED", false, 1],
    ["release", "CLOSED", false, 1],
  ] as const)("review-comment: %s %s deferred=%s", async (workflow, state, deferred, expected) => {
    const dir = mkdtempSync(join(tmpdir(), "omi-release-review-"));
    try {
      const file = join(dir, "review.md");
      writeFileSync(file, review(deferred));
      const { ctx, seen } = context(workflow, state);
      expect(await main(["review-comment", "314", "--file", file], ctx)).toBe(expected);
      expect(seen.some((c) => c.args[0] === "pr" && c.args[1] === "comment")).toBe(expected === 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["release", 0],
    ["feature", 1],
  ] as const)("merge reads the linked Issue workflow %s", async (workflow, expected) => {
    const { ctx, seen } = context(workflow, "OPEN");
    expect(await main(["merge", "314", "--head", head, "--dry-run"], ctx)).toBe(expected);
    if (expected === 0)
      expect(seen.some((c) => c.args[1]?.endsWith("rules/branches/main"))).toBe(true);
  });
});

describe("Issue relation commands", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omi-relations-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const body = `## Mục tiêu
Do it.
## Phạm vi
One change.
## Acceptance criteria
- [ ] Works
## Implementation map
- src/domain/tasks/task.ts
## Dependencies
None.
<!-- omi-squad:plan-key=OMI-186 -->`;
  function context(
    options: {
      noItem?: boolean;
      full?: boolean;
      badEpic?: boolean;
      foreignParent?: boolean;
      foreignBlocker?: boolean;
      parentError?: number;
    } = {},
  ) {
    const seen: Command[] = [];
    let blocked = false;
    let parent = 1;
    let currentBody = body;
    const { ctx } = fakeContext();
    const run: Runner = (command) => {
      seen.push(command);
      const path = command.args[1] ?? "";
      const write = command.args.includes("POST") || command.args.includes("PATCH");
      let result: unknown = {};
      if (path === "graphql")
        result = {
          data: {
            organization: {
              projectV2: {
                id: "project",
                field: { id: "status", options: [{ id: "backlog", name: "Backlog" }] },
              },
            },
            repository: {
              issue: {
                state: "OPEN",
                body: currentBody,
                comments: { nodes: [] },
                timelineItems: { nodes: [] },
                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                projectItems: {
                  nodes: options.noItem
                    ? []
                    : [
                        {
                          id: "item",
                          project: { id: "project" },
                          planKey: { text: "OMI-186" },
                          priority: { name: "P1" },
                          workType: { name: "Task" },
                          workflow: { name: "feature" },
                          role: { name: "Developer" },
                          area: { name: "domain" },
                          status: { name: "In Progress" },
                        },
                      ],
                },
              },
            },
          },
        };
      else if (path.includes("blocked_by")) {
        if (write) blocked = true;
        result = [
          [
            ...(options.foreignBlocker ? [{ number: 2, id: 202 }] : []),
            ...(blocked ? [{ number: 2, id: 102 }] : []),
          ],
        ];
      } else if (path.includes("/sub_issues?"))
        result = [Array.from({ length: options.full ? 100 : 0 }, (_, i) => ({ number: i + 200 }))];
      else if (path.endsWith("/sub_issues")) parent = 3;
      else if (path.endsWith("/parent")) {
        if (options.parentError)
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr: `gh: Not Found (HTTP ${String(options.parentError)})`,
          });
        result = {
          number: options.foreignParent && parent === 1 ? 3 : parent,
          id: parent === 1 ? 101 : 103,
        };
      } else if (path.endsWith("/issues/2")) result = { id: 102 };
      else if (path.endsWith("/issues/3"))
        result = { id: 103, body: options.badEpic ? "task" : "<!-- omi-squad:plan-key=EP-03 -->" };
      else if (path.endsWith("/issues/9")) {
        if (write) currentBody = (JSON.parse(command.input ?? "{}") as { body: string }).body;
        result = { id: 109, body: currentBody };
      }
      return Promise.resolve({ code: 0, stdout: JSON.stringify(result), stderr: "" });
    };
    return { ctx: { ...ctx, run }, seen };
  }
  const writes = (seen: Command[]) =>
    seen.filter(
      (c) =>
        c.args.includes("POST") ||
        c.args.includes("PATCH") ||
        c.args.includes("item-edit") ||
        (c.args[0] === "issue" && c.args[1] === "comment"),
    );

  it("block links the native dependency, returns to Backlog, comments once and then writes nothing", async () => {
    const { ctx, seen } = context();
    const args = ["block", "9", "--by", "2", "--reason", "Needs dependency"];
    expect(await main(args, ctx)).toBe(0);
    expect(writes(seen)).toHaveLength(3);
    expect(
      seen.find((c) => c.args[1]?.endsWith("blocked_by") && c.args.includes("POST"))?.input,
    ).toBe('{"issue_id":102}');
    expect(seen.some((c) => c.args.includes("item-edit") && c.args.includes("backlog"))).toBe(true);
    expect(seen.some((c) => (c.input ?? c.args.join(" ")).includes("Needs dependency"))).toBe(true);
    seen.length = 0;
    expect(await main(args, ctx)).toBe(0);
    expect(writes(seen)).toEqual([]);
  });
  it("block compares dependency identity across repositories", async () => {
    const { ctx, seen } = context({ foreignBlocker: true });
    expect(await main(["block", "9", "--by", "2", "--reason", "Wait"], ctx)).toBe(0);
    expect(writes(seen)).toHaveLength(3);
  });
  it("block refuses a missing Project item before writing the link", async () => {
    const { ctx, seen } = context({ noItem: true });
    expect(await main(["block", "9", "--by", "2", "--reason", "Wait"], ctx)).toBe(1);
    expect(writes(seen)).toEqual([]);
  });
  it("set-epic replaces the native parent and then writes nothing", async () => {
    const { ctx, seen } = context();
    expect(await main(["set-epic", "9", "--epic", "3"], ctx)).toBe(0);
    expect(writes(seen)).toHaveLength(1);
    expect(writes(seen)[0]?.input).toBe('{"sub_issue_id":109,"replace_parent":true}');
    seen.length = 0;
    expect(await main(["set-epic", "9", "--epic", "3"], ctx)).toBe(0);
    expect(writes(seen)).toEqual([]);
  });
  it("set-epic compares parent identity across repositories", async () => {
    const { ctx, seen } = context({ foreignParent: true });
    expect(await main(["set-epic", "9", "--epic", "3"], ctx)).toBe(0);
    expect(writes(seen)).toHaveLength(1);
  });
  it("set-epic attaches an Issue without a parent", async () => {
    const { ctx, seen } = context({ parentError: 404 });
    expect(await main(["set-epic", "9", "--epic", "3"], ctx)).toBe(0);
    expect(writes(seen)).toHaveLength(1);
  });
  it("set-epic propagates parent read errors without writing", async () => {
    const { ctx, seen } = context({ parentError: 403 });
    await expect(main(["set-epic", "9", "--epic", "3"], ctx)).rejects.toThrow(/parent/);
    expect(writes(seen)).toEqual([]);
  });
  it.each([{ full: true }, { badEpic: true }])(
    "set-epic refuses an invalid or full target (%j)",
    async (options) => {
      const { ctx, seen } = context(options);
      expect(await main(["set-epic", "9", "--epic", "3"], ctx)).toBe(1);
      expect(writes(seen)).toEqual([]);
    },
  );
  it("edit-issue replaces only the body, warns on top-level AC count and then writes nothing", async () => {
    const { ctx, seen } = context();
    const file = join(dir, "body.md");
    const replacement = body.replace("- [ ] Works", "- [ ] Changed\n- [ ] Another\n  - [ ] Nested");
    writeFileSync(file, replacement.replace("\n<!-- omi-squad:plan-key=OMI-186 -->", ""));
    expect(await main(["edit-issue", "9", "--file", file], ctx)).toBe(0);
    expect(writes(seen)).toHaveLength(1);
    expect(JSON.parse(writes(seen)[0]?.input ?? "{}")).toEqual({ body: replacement });
    expect(vi.mocked(console.warn).mock.calls.flat().join()).toContain("1 -> 2");
    seen.length = 0;
    expect(await main(["edit-issue", "9", "--file", file], ctx)).toBe(0);
    expect(writes(seen)).toEqual([]);
  });
  it("edit-issue reuses the task spec parser and changes only the body", async () => {
    const { ctx, seen } = context();
    const file = join(dir, "spec.md");
    const replacement = body.replace("Works", "Updated");
    writeFileSync(
      file,
      `---\ntitle: Ignored title\npriority: P1\nworkType: Task\nworkflow: feature\nrole: Developer\narea: domain\nmilestone: M1\nepic: 1\nblockedBy: []\n---\n${replacement}`,
    );
    expect(await main(["edit-issue", "9", "--file", file], ctx)).toBe(0);
    expect(JSON.parse(writes(seen)[0]?.input ?? "{}")).toEqual({ body: replacement });
    expect(writes(seen)).toHaveLength(1);
  });
  it.each(["bad body", body.replace("OMI-186", "OMI-999")])(
    "edit-issue rejects an invalid replacement before writing",
    async (replacement) => {
      const { ctx, seen } = context();
      const file = join(dir, "body.md");
      writeFileSync(file, replacement);
      expect(await main(["edit-issue", "9", "--file", file], ctx)).toBe(1);
      expect(writes(seen)).toEqual([]);
    },
  );
  it.each([
    ["block", "9", "--by", "2", "--reason", "Wait"],
    ["set-epic", "9", "--epic", "3"],
  ])("dry run only reads for %s", async (...args) => {
    const { ctx, seen } = context();
    expect(await main([...args, "--dry-run"], ctx)).toBe(0);
    expect(writes(seen)).toEqual([]);
  });
  it("edit-issue dry run only reads", async () => {
    const { ctx, seen } = context();
    const file = join(dir, "body.md");
    writeFileSync(file, body.replace("Works", "Changed"));
    expect(await main(["edit-issue", "9", "--file", file, "--dry-run"], ctx)).toBe(0);
    expect(writes(seen)).toEqual([]);
  });
});
