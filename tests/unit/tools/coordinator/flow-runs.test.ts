import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, main, type Context } from "../../../../tools/coordinator/flow.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

// A fake wsl.exe answers the ~/omi-runs listing; a fake gh answers the Project snapshot. Nothing
// real is read or changed: the "change" script is only recorded.
const NOW = 2_000_000_000;
const OLD = NOW - 5 * 3600;
const LISTING = [
  "@@now",
  String(NOW),
  "@@open",
  "@@root",
  `omi-052-prompt.md|10|${String(OLD)}`,
  `omi-052-ggtintran-20261110-202514.jsonl|900|${String(OLD)}`,
  `omi-052-ggtintran-20261110-203511.jsonl|900|${String(OLD + 60)}`,
  `omi-052-current|0|${String(OLD)}`,
  `omi-056-prompt.md|10|${String(OLD)}`,
  `omi-056-minibox-20261111-090000.jsonl|900|${String(OLD)}`,
  "@@archive",
  `omi-001-prompt.md.gz|10|${String(NOW - 40 * 86400)}`,
  "",
].join("\n");

const BRANCH = "task/omi-052-effort-policy";
const text = (c: Command) => [c.file, ...c.args].join(" ");
const isListing = (c: Command) => (c.args.at(-1) ?? "").includes("@@now");
const isScript = (c: Command) => /rm -f|gzip/.test(c.args.at(-1) ?? "");

function context(statuses: Record<number, string> = {}) {
  const seen: Command[] = [];
  const key = (n: number) => `OMI-${String(n).padStart(3, "0")}`;
  const snapshot = {
    organization: {
      projectV2: {
        title: "Project",
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: Object.entries(statuses).map(([n, status]) => ({
            status: { name: status },
            priority: { name: "P1" },
            workType: { name: "Task" },
            workflow: { name: "feature" },
            role: { name: "Developer" },
            area: { name: "tooling" },
            planKey: { text: key(Number(n)) },
            content: {
              __typename: "Issue",
              number: Number(n) + 20,
              title: `[${key(Number(n))}] t`,
              state: "OPEN",
              body: "",
              milestone: { title: "M1" },
              blockedBy: { totalCount: 0, nodes: [] },
            },
          })),
        },
      },
    },
    repository: { pullRequests: { nodes: [] } },
  };
  const run: Runner = (command) => {
    seen.push(command);
    let stdout = "";
    if (command.file === "gh") stdout = JSON.stringify({ data: snapshot });
    else if (isListing(command)) stdout = LISTING;
    else if ((command.args.at(-1) ?? "").includes("worktree list"))
      stdout = "worktree /home/u/omi\0branch refs/heads/develop\0\0";
    else if (command.args.includes("remote")) stdout = "";
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
  const target = { viaWslExe: false, distro: "Ubuntu-24.04", repoDir: "/home/u/omi" };
  const ctx: Context = { run, target, hostCwd: "/x", isWindows: false };
  return { ctx, seen };
}

const logs = () => vi.mocked(console.log).mock.calls.flat().join("\n");

describe("flow log retention", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("prune-runs --dry-run lists, prints what it would do, and changes nothing", async () => {
    const { ctx, seen } = context({ 52: "Done", 56: "In Progress" });
    expect(await main(["prune-runs", "--dry-run"], ctx)).toBe(0);
    expect(seen.filter(isScript)).toHaveLength(0);
    expect(seen.filter((c) => c.file === "bash").every(isListing)).toBe(true);
    const out = logs();
    expect(out).toContain("would archive omi-052-prompt.md");
    expect(out).toContain("would archive omi-052-ggtintran-20261110-202514.jsonl");
    expect(out).toContain("would delete omi-052-current");
    expect(out).toContain("would delete archive/omi-001-prompt.md.gz");
    expect(out).not.toContain("omi-052-ggtintran-20261110-203511.jsonl (");
    expect(out).not.toContain("omi-056"); // not Done
    expect(out).toContain("would run: bash -lc");
  });

  it("prune-runs runs one script through the runner; a failing script fails the command", async () => {
    const { ctx, seen } = context({ 52: "Done" });
    expect(await main(["prune-runs"], ctx)).toBe(0);
    const scripts = seen.filter(isScript);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.args.at(-1)).toContain("mv -f $f archive/$f && gzip -f archive/$f");

    const failing = context({ 52: "Done" });
    const base = failing.ctx.run;
    const ctx2: Context = {
      ...failing.ctx,
      run: (c) =>
        isScript(c) ? Promise.resolve({ code: 1, stdout: "", stderr: "boom" }) : base(c),
    };
    expect(await main(["prune-runs"], ctx2)).toBe(1);
  });

  it("prune-runs with no Done task only reports the archive cap, never touches the root", async () => {
    const { ctx } = context({ 56: "In Progress" });
    expect(await main(["prune-runs", "--dry-run"], ctx)).toBe(0);
    const out = logs();
    expect(out).toContain("would delete archive/omi-001-prompt.md.gz");
    expect(out).not.toMatch(/would (archive|delete) omi-/);
  });

  it("cleanup archives only the logs of its own task after the branch step", async () => {
    const { ctx, seen } = context();
    expect(await cleanup(ctx, BRANCH, true)).toBe(true);
    const out = logs();
    expect(out).toContain("would archive omi-052-prompt.md");
    expect(out).not.toContain("omi-056");
    expect(seen.map(text).at(-1)).toContain("@@now");
  });
});
