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
      else if (payload.includes("worktree remove")) removed = true;
      else if (payload.includes("branch -d")) branchGone = true;
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

  it("removes the linked worktree, fast-forwards main develop, safely deletes, then reads logs", async () => {
    const { ctx, seen } = worktreeContext();
    expect(await cleanup(ctx, BRANCH, false)).toBe(true);
    const write = seen.find((c) => text(c).includes("worktree remove"));
    expect(write?.args).toContain("/main repo");
    expect(write?.args.at(-1)).toBe(
      `git -C '/main repo' worktree remove -- '/task repo' && git -C '/main repo' merge --ff-only origin/develop && git -C '/main repo' branch -d ${BRANCH}`,
    );
    expect(seen.at(-1)?.args).toContain("/main repo");
    expect(isRunsListing(seen.at(-1) ?? { file: "", args: [] })).toBe(true);
    expect(seen.map(text).join("\n")).not.toMatch(/switch|branch -D/);
    seen.length = 0;
    expect(await cleanup(ctx, BRANCH, false)).toBe(true);
    expect(seen.map(text).join("\n")).not.toMatch(/fetch|worktree remove|branch -d/);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("done:");
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
    expect(seen.map(text).join("\n")).toContain("branch -d");
  });

  it("dry-run prints removal and safe deletion but only reads", async () => {
    const { ctx, seen } = worktreeContext();
    expect(await cleanup(ctx, BRANCH, true)).toBe(true);
    expect(seen.map(text).join("\n")).not.toMatch(/fetch|worktree remove|branch -d/);
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("worktree remove");
    expect(output).toContain("branch -d");
  });

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

  function context(workflow: string | null = "feature", labels: string[] = []) {
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

  it("keeps the quota refusal and does not read Issue fields when no profile is usable", async () => {
    const { ctx, seen } = context();
    expect(await pickProfileCommand(ctx, 93, "claude", false, true)).toBe(1);
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
    });
    expect(seen.some((command) => command.file === "gh")).toBe(false);
  });
});
