import { describe, expect, it } from "vitest";
import type { WslTarget } from "../../../../tools/coordinator/coordinator-settings.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";
import {
  parseProcesses,
  parseWorkerArgs,
  parseWorkerTail,
  workerLogIdentity,
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

  it("keeps display metadata, never the worker's argv", () => {
    const procs = parseProcesses("7 65 claude -p --allowedTools Bash(gh pr view *) secret-prompt");
    expect(procs).toEqual([
      { pid: 7, tool: "claude", headless: true, elapsedSeconds: 65, model: null, effort: null },
    ]);
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

describe("worker display metadata", () => {
  it("parses Claude and Codex model/effort flags without retaining the prompt", () => {
    expect(parseWorkerArgs("claude -p --model opus-5-5 --effort high", "claude")).toEqual({
      model: "opus-5-5",
      effort: "high",
    });
    expect(
      parseWorkerArgs('codex exec -m gpt-6.1-sol -c model_reasoning_effort="high" --json', "codex"),
    ).toEqual({ model: "gpt-6.1-sol", effort: "high" });
    expect(
      parseWorkerArgs("codex -m gpt-6.1-sol -c 'model_reasoning_effort=medium'", "codex"),
    ).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
    expect(
      parseWorkerArgs("claude --model=sonnet --effort=low -- --model secret", "claude"),
    ).toEqual({ model: "sonnet", effort: "low" });
    expect(parseWorkerArgs("codex -m", "codex")).toEqual({ model: null, effort: null });
  });

  it("derives task/profile from both dispatch filename forms, not the most recent log", () => {
    expect(
      workerLogIdentity("/runs/omi-064-codex-ggtintran-20261111-135052.jsonl", "codex"),
    ).toEqual({ task: "OMI-064", profile: "ggtintran" });
    expect(workerLogIdentity("/runs/omi-004-team-profile-20261111-135052.jsonl", "claude")).toEqual(
      { task: "OMI-004", profile: "team-profile" },
    );
    // OMI-113: the packet id after the timestamp must not leak into the profile
    expect(
      workerLogIdentity(
        "/runs/omi-107-ggtintran-20261113-163149-verify-1-mwes2dr4dc7f7a.jsonl",
        "claude",
      ),
    ).toEqual({ task: "OMI-107", profile: "ggtintran" });
    expect(
      workerLogIdentity(
        "/runs/omi-107-codex-ggtintran-20261113-163149-review-1-abc123.jsonl",
        "codex",
      ),
    ).toEqual({ task: "OMI-107", profile: "ggtintran" });
    expect(workerLogIdentity("/dev/pts/0", "claude")).toEqual({ task: null, profile: null });
  });
});

const jsonl = (...events: readonly unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");

describe("worker log tail", () => {
  it("reads Claude assistant tools/text and authoritative result count", () => {
    const tool = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm run check" } }],
      },
    };
    expect(parseWorkerTail(jsonl(tool))).toMatchObject({
      numTurns: 1,
      lastAction: "Bash npm run check",
      finished: false,
    });
    const tail = jsonl(
      tool,
      { type: "assistant", message: { content: [{ type: "text", text: "All checks\npassed" }] } },
      { type: "result", num_turns: 37, is_error: false },
    );
    expect(parseWorkerTail(tail)).toEqual({
      numTurns: 37,
      lastAction: "All checks passed",
      finished: true,
      isError: false,
      limited: false,
    });
  });

  it("supports the real Codex exec event shape, including in-progress commands", () => {
    const tail = jsonl(
      { type: "thread.started", thread_id: "not-retained" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "1", type: "agent_message", text: "Checking" } },
      {
        type: "item.started",
        item: {
          id: "2",
          type: "command_execution",
          command: "npm run check",
          aggregated_output: "not-retained",
          status: "in_progress",
        },
      },
    );
    expect(parseWorkerTail(tail)).toEqual({
      numTurns: 1,
      lastAction: "command npm run check",
      finished: false,
      isError: false,
      limited: false,
    });
    expect(
      parseWorkerTail(
        tail +
          "\n" +
          jsonl(
            { type: "item.completed", item: { type: "agent_message", text: "Done" } },
            { type: "turn.completed", usage: {} },
          ),
      ),
    ).toMatchObject({ lastAction: "Done", finished: true });
  });

  it("handles partial/malformed lines, errors, rate limits and terminal controls", () => {
    const tail =
      "broken\n" +
      jsonl(
        { type: "turn.started" },
        { type: "turn.failed", error: { message: "Usage limit reached\u001b[2J" } },
      ) +
      '\n{"type":';
    expect(parseWorkerTail(tail)).toMatchObject({
      numTurns: 1,
      finished: true,
      isError: true,
      limited: true,
    });
    expect(parseWorkerTail(tail).lastAction).not.toContain("\u001b");
    expect(
      parseWorkerTail(jsonl({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } })),
    ).toMatchObject({ limited: true });
    expect(parseWorkerTail(jsonl({ type: "result", is_error: true, num_turns: -5 }))).toMatchObject(
      { isError: true, numTurns: 0 },
    );
  });
});

it("collapses a Codex node wrapper and musl binary to the root pid, regardless of ps order", () => {
  const ps = [
    "201 60 200 /opt/codex/x86_64-unknown-linux-musl/codex/codex exec --json -m gpt-6.1-sol",
    "200 61 1 node /opt/bin/codex exec --json -m gpt-6.1-sol",
    "300 10 1 node /opt/bin/codex exec --json",
    "301 9 300 /opt/codex/x86_64-unknown-linux-musl/codex/codex exec --json",
  ];
  for (const lines of [ps, [...ps].reverse()])
    expect(
      parseProcesses(lines.join("\n"))
        .map((p) => p.pid)
        .sort(),
    ).toEqual([200, 300]);
});

it("collapses unrelated processes writing the same log but keeps separate workers", async () => {
  const run: Runner = (command) =>
    Promise.resolve({
      code: 0,
      stderr: "",
      stdout: command.input
        ? [201, 200, 300]
            .map((pid) =>
              JSON.stringify({
                pid,
                path: `/runs/omi-068-codex-${pid === 300 ? "other" : "test"}-20261111-120000.jsonl`,
                summary: {
                  numTurns: 4,
                  lastAction: "checking",
                  finished: false,
                  isError: false,
                  limited: false,
                },
              }),
            )
            .join("\n")
        : "@@ps\n201 60 1 /opt/codex/codex exec --json\n200 61 1 node /opt/bin/codex exec --json\n300 30 1 codex exec --json\n@@log\n",
    });
  const result = await readWorkers(run, windows);
  expect(result.available && result.processes.map((p) => [p.pid, p.profile])).toEqual([
    [200, "test"],
    [300, "other"],
  ]);
});

it("tells which per-dispatch packet file each parallel worker of one task reads (OMI-111)", async () => {
  const packets: Record<number, string> = {
    200: "/runs/omi-068-prompt-verify-2.md",
    300: "/runs/omi-068-prompt-review-2.md",
    400: "/runs/stray.md",
  };
  const run: Runner = (command) =>
    Promise.resolve({
      code: 0,
      stderr: "",
      stdout: command.input
        ? [200, 300, 400]
            .map((pid) =>
              JSON.stringify({
                pid,
                path: `/runs/omi-068-claude-${String(pid)}-20261111-120000.jsonl`,
                packet: packets[pid],
                summary: {
                  numTurns: 1,
                  lastAction: null,
                  finished: false,
                  isError: false,
                  limited: false,
                },
              }),
            )
            .join("\n")
        : "@@ps\n200 60 1 claude -p\n300 50 1 claude -p\n400 40 1 claude -p\n@@log\n",
    });
  const result = await readWorkers(run, windows);
  expect(result.available && result.processes.map((p) => [p.pid, p.packet])).toEqual([
    [200, "omi-068-prompt-verify-2.md"],
    [300, "omi-068-prompt-review-2.md"],
    [400, null], // not a packet file name: never trusted
  ]);
});
