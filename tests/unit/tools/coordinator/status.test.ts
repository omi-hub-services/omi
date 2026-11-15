import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { posix } from "node:path";
import * as status from "../../../../tools/coordinator/status.ts";
import * as workers from "../../../../tools/coordinator/wsl-workers.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";
import type { ProjectItem } from "../../../../tools/coordinator/github-snapshot.ts";

const target = { viaWslExe: true, distro: "Ubuntu", repoDir: "/home/u/github/omi" };
const sha = "a".repeat(40);
const local = {
  worktrees: [
    { path: "/home/u/github/omi-wt/omi-172", branch: "task/omi-172-handoff", dirty: true },
  ],
  unpushedBranches: ["task/omi-173-next"],
};

describe("status handoff and local state", () => {
  it("runs the WSL payload for paths with spaces, detached worktrees and branches ahead of origin", () => {
    const output: string[] = [];
    const git = vi.fn((_file: string, args: string[], options: { cwd: string }) => {
      if (args.includes("worktree"))
        return "worktree /home/u/github/omi\0branch refs/heads/develop\0\0worktree /home/u/github/omi-wt/task space\0branch refs/heads/task/omi-172-handoff\0\0worktree /home/u/github/omi-wt/detached\0detached\0\0";
      if (args.includes("status"))
        return options.cwd.endsWith("task space") ? "?? change.md\n" : "";
      if (args.includes("for-each-ref"))
        return "task/omi-172-handoff\ntask/omi-173-next\ntask/omi-174-ahead\n";
      if (args.includes("task/omi-172-handoff")) return "0\n";
      if (args.includes("task/omi-173-next")) throw new Error("no remote branch");
      return "1\n";
    });
    runInNewContext(workers.LOCAL_STATE_PROBE.replace(/^import .*;$/gm, ""), {
      execFileSync: git,
      homedir: () => "/home/u",
      join: (...paths: string[]) => posix.join(...paths),
      process: { cwd: () => "/home/u/github/omi" },
      console: { log: (s: string) => output.push(s) },
    });
    expect(JSON.parse(output[0] ?? "{}")).toEqual({
      worktrees: [
        { path: "/home/u/github/omi-wt/task space", branch: "task/omi-172-handoff", dirty: true },
        { path: "/home/u/github/omi-wt/detached", branch: "(detached)", dirty: false },
      ],
      unpushedBranches: ["task/omi-173-next", "task/omi-174-ahead"],
    });
  });
  it("collects local state using one WSL call, one host status, and pin status", async () => {
    const seen: Command[] = [];
    const run: Runner = (c) => {
      seen.push(c);
      const stdout =
        c.file === "wsl.exe"
          ? JSON.stringify(local)
          : c.args.includes("status") && c.file === "git"
            ? " M AGENTS.md\0"
            : c.args.includes("rev-parse")
              ? sha
              : JSON.stringify({ record: { sha }, initialized: true, installedSha: sha });
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    };
    const state = await workers.readLocalState(run, target, "C:/omi");
    expect(state.wsl).toEqual({ available: true, ...local });
    expect(state.host).toEqual({ available: true, modifiedTrackedFiles: [" M AGENTS.md"] });
    expect(state.pin).toMatchObject({
      available: true,
      sha,
      developSha: sha,
      matchesDevelop: true,
    });
    expect(seen.filter((c) => c.file === "wsl.exe")).toHaveLength(1);
    expect(seen.filter((c) => c.file === "git" && c.args.includes("status"))).toHaveLength(1);
    expect(
      seen.some((c) => c.args.some((a) => a.endsWith("pin.ts")) && c.args.includes("status")),
    ).toBe(true);
    expect(seen.every((c) => !c.args.includes("fetch"))).toBe(true);
  });
  it("retains host and pin state when WSL is unavailable", async () => {
    const run: Runner = (c) =>
      Promise.resolve(
        c.file === "wsl.exe"
          ? { code: 127, stdout: "", stderr: "WSL unavailable" }
          : {
              code: 0,
              stdout:
                c.file === "git"
                  ? c.args.includes("status")
                    ? ""
                    : sha
                  : JSON.stringify({ record: null, initialized: false, reason: "first install" }),
              stderr: "",
            },
      );
    const state = await workers.readLocalState(run, target, "C:/omi");
    expect(state.wsl.available).toBe(false);
    if (!state.wsl.available) expect(state.wsl.reason).toContain("WSL unavailable");
    expect(state.host.available).toBe(true);
    expect(state.pin).toMatchObject({ available: true, sha: null, matchesDevelop: false });
  });
  it("prints handoff and age first, local state and one next line per active Issue in text and JSON", async () => {
    const run: Runner = (c) =>
      Promise.resolve({
        code: 0,
        stdout: `next ${c.args.at(-1) ?? ""}: review\nmore commands`,
        stderr: "",
      });
    const items: Pick<ProjectItem, "kind" | "number" | "status">[] = [
      { kind: "Issue", number: 342, status: "In Progress" },
      { kind: "Issue", number: 343, status: "In Review" },
      { kind: "Issue", number: 344, status: "Ready" },
      { kind: "PullRequest", number: 345, status: "In Review" },
      { kind: "DraftIssue", number: null, status: "In Progress" },
    ];
    const next = await status.readNextLines(run, items, "/host");
    expect(next).toEqual([
      { number: 342, result: "next 342: review" },
      { number: 343, result: "next 343: review" },
    ]);
    const handoff = status.handoffView(
      "# Coordinator handoff\n\nUpdated: 2026-11-15T10:00:00.000Z · develop: abc · Coordinator: coordinator\n\n## Stop reason\n- PO stopped",
      new Date("2026-11-15T12:00:00Z"),
    );
    expect(handoff.ageSeconds).toBe(7200);
    const report: Parameters<typeof status.renderText>[0] = {
      generatedAt: "2026-11-15T12:00:00Z",
      project: "Delivery",
      handoff,
      localState: {
        wsl: { available: true, ...local },
        host: { available: true, modifiedTrackedFiles: [" M AGENTS.md"] },
        pin: {
          available: true,
          sha,
          developSha: sha,
          matchesDevelop: true,
          initialized: true,
          reason: undefined,
        },
      },
      next,
      groups: [],
      ready: [],
      readyBlocked: [],
      backlog: [],
      requiredChecks: [],
      pulls: [],
      mismatches: [],
      workers: { available: false, reason: "offline" },
      quota: { available: false, reason: "offline" },
    };
    const text = status.renderText(report);
    expect(text.startsWith("Coordinator handoff (2h ago):\n# Coordinator handoff")).toBe(true);
    for (const value of [
      "Local state:",
      "task/omi-172-handoff dirty",
      "task/omi-173-next",
      " M AGENTS.md",
      sha,
      "next 342: review",
      "next 343: review",
    ])
      expect(text).toContain(value);
    const json = JSON.parse(status.renderJson(report)) as Record<string, unknown>;
    expect(json.handoff).toEqual(handoff);
    expect(json.localState).toEqual(report.localState);
    expect(json.next).toEqual(next);
  });
  it("reports unknown age for empty or malformed handoff timestamps", () => {
    for (const text of ["", "manual text", "Updated: invalid"])
      expect(status.handoffView(text, new Date()).ageSeconds).toBeNull();
  });
  it("keeps refused next results as one line without failing status", async () => {
    const run = vi
      .fn<Runner>()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "next 342: refused: no report\ndetail" });
    expect(
      await status.readNextLines(
        run,
        [{ kind: "Issue", number: 342, status: "In Review" }],
        "/host",
      ),
    ).toEqual([{ number: 342, result: "next 342: refused: no report" }]);
  });
});
