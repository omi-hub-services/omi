import { describe, expect, it } from "vitest";
import { probeBranch, wslGit } from "../../../../tools/coordinator/git-probe.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

const windows = { viaWslExe: true, distro: "Ubuntu-24.04", repoDir: "/home/u/omi" };
const payload = (c: Command) => c.args.at(-1) ?? "";

describe("probeBranch", () => {
  it("sends each git read to WSL as one Windows-safe argv payload", async () => {
    const seen: Command[] = [];
    const run: Runner = (c) => {
      seen.push(c);
      return Promise.resolve({ code: 0, stdout: "x\n", stderr: "" });
    };
    await probeBranch(run, wslGit(windows), "task/omi-051-x", { fetch: true, remote: true });
    expect(seen.every((c) => c.file === "wsl.exe" && !/["\\]/.test(payload(c)))).toBe(true);
    expect(payload(seen[0] ?? { file: "", args: [] })).toBe("git fetch --prune --quiet origin");
    expect(seen.map(payload)).toContain("git ls-remote origin refs/heads/task/omi-051-x");
  });

  it("throws when a status read fails, instead of reporting a clean checkout", async () => {
    const run: Runner = (c) =>
      Promise.resolve(
        payload(c).startsWith("git status")
          ? { code: 128, stdout: "", stderr: "fatal: not a git repository" }
          : { code: 0, stdout: "develop\n", stderr: "" },
      );
    await expect(probeBranch(run, wslGit(windows), "task/omi-051-x")).rejects.toThrow(
      /not a git repository/,
    );
  });
});
