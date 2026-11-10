import { describe, expect, it } from "vitest";
import type { WslTarget } from "../../../../tools/coordinator/coordinator-settings.ts";
import {
  formatCommand,
  joinSteps,
  shellQuote,
  wslCommand,
} from "../../../../tools/coordinator/process-runner.ts";
import { WORKER_PROBE } from "../../../../tools/coordinator/wsl-workers.ts";

const windows: WslTarget = { viaWslExe: true, distro: "Ubuntu-24.04", repoDir: "/home/u/omi" };
const linux: WslTarget = { ...windows, viaWslExe: false };

describe("shellQuote / joinSteps", () => {
  it("leaves plain words alone and single-quotes anything bash would interpret", () => {
    expect(shellQuote("task/omi-050-x")).toBe("task/omi-050-x");
    for (const s of ["a b", "$(id)", "`id`", "a;b", "a&&b", "*", "~", "", "a|b", "!x"]) {
      expect(shellQuote(s), s).toBe(`'${s}'`);
    }
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("quotes every argument separately so one argument cannot become two commands", () => {
    expect(
      joinSteps([
        ["git", "commit", "-m", "x; rm -rf ~"],
        ["git", "push"],
      ]),
    ).toBe("git commit -m 'x; rm -rf ~' && git push");
  });
});

describe("wslCommand", () => {
  it("on Windows passes argv to wsl.exe with the payload as the single bash -lc argument", () => {
    expect(wslCommand("git status", windows)).toEqual({
      file: "wsl.exe",
      args: ["-d", "Ubuntu-24.04", "--cd", "/home/u/omi", "--exec", "bash", "-lc", "git status"],
    });
  });

  it("inside Linux runs bash directly in the checkout", () => {
    expect(wslCommand("git status", linux, 5)).toEqual({
      file: "bash",
      args: ["-lc", "git status"],
      cwd: "/home/u/omi",
      timeoutMs: 5,
    });
  });

  it("rejects payloads that Windows command-line quoting would rewrite", () => {
    for (const p of [
      'echo "x"',
      "echo a\\b",
      "a\nb",
      joinSteps([["git", "commit", "-m", "it's"]]),
    ]) {
      expect(() => wslCommand(p, windows), p).toThrow(/must not contain/);
    }
  });

  it("accepts the fixed worker probe (it is built to be Windows-safe)", () => {
    expect(() => wslCommand(WORKER_PROBE, windows)).not.toThrow();
  });
});

describe("formatCommand", () => {
  it("shows stdin size, never stdin content", () => {
    const text = formatCommand({
      file: "gh",
      args: ["issue", "comment"],
      input: "secret-ish body",
    });
    expect(text).toBe("gh issue comment (stdin: 15 chars)");
  });
});
