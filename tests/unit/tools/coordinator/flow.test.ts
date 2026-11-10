import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, referencingPulls, type Context } from "../../../../tools/coordinator/flow.ts";
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
    if (sub === "remote") stdout = "https://github.com/omi-hub-services/omi.git\n";
    else if (sub === "rev-parse") stdout = flag === "--abbrev-ref" ? `${BRANCH}\n` : "abc\n";
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
  const target = { viaWslExe: true, distro: "Ubuntu-24.04", repoDir: "/home/u/omi" };
  return { ctx: { run, target, hostCwd: "C:\\omi", isWindows: true }, seen };
}

/** git argv of a single-command WSL payload (`git a b c`); a chained payload keeps its `&&`. */
const gitArgs = (c: Command) => (c.args.at(-1) ?? "").split(" ").slice(1);

const READ_ONLY_GIT = new Set(["remote", "rev-parse", "status", "merge-base"]);
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
    for (const c of seen) {
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
    expect(lines[0]).toMatch(/^wsl\.exe .* bash -lc git fetch --prune --quiet origin$/);
    expect(lines).toContain("git fetch --prune --quiet origin");
    expect(lines.filter((l) => l.includes("branch -D"))).toHaveLength(2);
  });
});
