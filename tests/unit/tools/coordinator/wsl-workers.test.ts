import { describe, expect, it } from "vitest";
import type { WslTarget } from "../../../../tools/coordinator/coordinator-settings.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";
import {
  parseProcesses,
  parseWorkerProbe,
  readWorkers,
} from "../../../../tools/coordinator/wsl-workers.ts";

const windows: WslTarget = { viaWslExe: true, distro: "Ubuntu-24.04", repoDir: "/home/u/omi" };

describe("parseProcesses", () => {
  it("finds claude and codex workers but not shells or greps that mention them", () => {
    const ps = [
      "12146     132 bash -lc claude -p --output-format stream-json < prompt.md",
      "12333     132 claude -p --output-format stream-json --verbose --max-turns 200",
      "  400      10 node /home/u/.nvm/versions/node/v24/bin/codex exec --json",
      "  401       5 /home/u/.local/bin/claude",
      "  402       1 grep claude",
      "  403       1 claude-helper --x",
    ].join("\n");
    expect(parseProcesses(ps).map((p) => [p.pid, p.tool, p.headless])).toEqual([
      [12333, "claude", true],
      [400, "codex", true],
      [401, "claude", false],
    ]);
  });

  it("keeps only tool, pid, mode and elapsed time, never the worker's argv", () => {
    const procs = parseProcesses("7 65 claude -p --allowedTools Bash(gh pr view *) secret-prompt");
    expect(procs).toEqual([{ pid: 7, tool: "claude", headless: true, elapsedSeconds: 65 }]);
    expect(JSON.stringify(procs)).not.toMatch(/allowedTools|secret-prompt/);
  });
});

describe("parseWorkerProbe", () => {
  const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", model: "m" });

  it("reads a finished run from the result event without exposing message text", () => {
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 12,
      result: "long answer text",
    });
    const out = `@@ps\n@@log\n/home/u/omi-runs/omi-050-1.jsonl|1000|4096\n@@now\n1060\n@@first\n${init}\n@@last\n${result}\n`;
    const report = parseWorkerProbe(out);
    expect(report.latestLog).toEqual({
      file: "omi-050-1.jsonl",
      sizeBytes: 4096,
      ageSeconds: 60,
      sessionId: "s-1",
      model: "m",
      lastEvent: "result/success",
      finished: true,
      isError: false,
      numTurns: 12,
    });
    expect(JSON.stringify(report)).not.toContain("long answer text");
  });

  it("treats a truncated last line as a running, unreadable event", () => {
    const out = `@@ps\n@@log\n/r/a.jsonl|5|10\n@@now\n5\n@@first\n${init}\n@@last\n{"type":"assis\n`;
    expect(parseWorkerProbe(out).latestLog).toMatchObject({ lastEvent: null, finished: false });
  });

  it("reports no log when ~/omi-runs has none", () => {
    expect(parseWorkerProbe("@@ps\n1 1 bash\n@@log\n")).toEqual({ processes: [], latestLog: null });
  });
});

describe("readWorkers", () => {
  it("degrades to unavailable when wsl.exe cannot start, instead of throwing", async () => {
    const seen: Command[] = [];
    const run: Runner = (command) => {
      seen.push(command);
      return Promise.resolve({ code: 127, stdout: "", stderr: "spawn wsl.exe ENOENT" });
    };
    const w = await readWorkers(run, windows);
    expect(w.available).toBe(false);
    expect(w.available ? "" : w.reason).toContain("ENOENT");
    expect(seen.map((c) => [c.file, c.args.length])).toEqual([["wsl.exe", 8]]);
  });
});
