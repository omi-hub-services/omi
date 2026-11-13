import { describe, expect, it } from "vitest";
import {
  formatReport,
  isCodexLog,
  newestLogCommand,
  parseClaudeReport,
  parseCodexReport,
} from "../../../../tools/coordinator/worker-report.ts";

const line = (o: unknown) => JSON.stringify(o);

describe("parseClaudeReport", () => {
  const log = [
    line({ type: "system", subtype: "init", session_id: "sess-1" }),
    line({ type: "assistant", message: {} }),
    line({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      num_turns: 3,
      result: "short",
      permission_denials: [],
    }),
    line({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      num_turns: 42,
      result: "the longest final report of the run",
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "git push origin x" } },
        { tool_name: "Write", tool_input: { file_path: ".claude/x" } },
      ],
    }),
    line({ type: "result", session_id: "sess-1", num_turns: 43, result: "tiny" }),
  ].join("\n");

  it("takes the longest result among the result events", () => {
    expect(parseClaudeReport(log).report).toBe("the longest final report of the run");
  });

  it("reports turns, session id and permission denials of the last result event", () => {
    const r = parseClaudeReport(log);
    expect(r.sessionId).toBe("sess-1");
    expect(r.turns).toBe(43);
    expect(r.denials).toEqual([]);
  });

  it("lists the permission denials with the tool and a short subject", () => {
    const r = parseClaudeReport(
      line({
        type: "result",
        session_id: "s",
        num_turns: 1,
        result: "r",
        permission_denials: [
          { tool_name: "Bash", tool_input: { command: "git push origin x" } },
          { tool_name: "Write", tool_input: { file_path: ".claude/x" } },
          { tool_name: "Other", tool_input: {} },
        ],
      }),
    );
    expect(r.denials).toEqual(["Bash: git push origin x", "Write: .claude/x", "Other"]);
  });

  it("falls back to the init session id and reports no report when the run did not finish", () => {
    const r = parseClaudeReport(
      [line({ type: "system", subtype: "init", session_id: "s9" }), '{"type":"assis'].join("\n"),
    );
    expect(r).toMatchObject({ report: null, turns: null, sessionId: "s9", denials: [] });
  });

  it("skips lines that are not JSON", () => {
    const r = parseClaudeReport(
      `not json\n${line({ type: "result", result: "ok", num_turns: 1 })}`,
    );
    expect(r.report).toBe("ok");
  });
});

describe("parseCodexReport", () => {
  it("returns the last message and the thread id of the first jsonl line", () => {
    const jsonl = [
      line({ type: "thread.started", thread_id: "0199-thread" }),
      line({ type: "turn.started" }),
      line({ type: "turn.started" }),
      line({ type: "turn.completed" }),
    ].join("\n");
    expect(parseCodexReport(jsonl, "final words\n")).toMatchObject({
      report: "final words\n",
      threadId: "0199-thread",
      turns: 2,
    });
  });

  it("has no thread id when the first line is not thread.started", () => {
    expect(parseCodexReport(line({ type: "turn.started" }), "")).toMatchObject({
      threadId: null,
      report: null,
    });
  });
});

describe("isCodexLog / newestLogCommand", () => {
  it("tells a Codex log by its name", () => {
    expect(isCodexLog("omi-077-codex-ggtintran-20261112-101500.jsonl")).toBe(true);
    expect(isCodexLog("omi-077-ggtintran-20261112-101500.jsonl")).toBe(false);
  });

  it("lists the newest jsonl of the task, WSL-safe", () => {
    const payload = newestLogCommand("077");
    expect(payload).toContain("ls -t $HOME/omi-runs/omi-077-*.jsonl");
    expect(payload).not.toMatch(/["\\\n\r]/);
  });

  it("selects the newest log of one step among parallel workers (OMI-113)", () => {
    const payload = newestLogCommand("107", "review-1");
    expect(payload).toContain("ls -t $HOME/omi-runs/omi-107-**-review-1-*.jsonl");
    expect(payload).not.toMatch(/["\\\n\r]/);
    expect(() => newestLogCommand("107", "x; id")).toThrow(/step/);
  });
});

describe("formatReport", () => {
  it("prints the report first and the facts as labelled lines", () => {
    const text = formatReport({
      tool: "claude",
      file: "omi-077-p-1.jsonl",
      report: "BODY",
      turns: 7,
      denials: ["Bash: git push"],
      resumeId: "sess-1",
    });
    expect(text).toContain("BODY");
    expect(text).toContain("turns: 7");
    expect(text).toContain("permission denials: 1");
    expect(text).toContain("  Bash: git push");
    expect(text).toContain("session id: sess-1");
  });

  it("says plainly when there is no final report", () => {
    expect(
      formatReport({
        tool: "codex",
        file: "f",
        report: null,
        turns: null,
        denials: [],
        resumeId: null,
      }),
    ).toContain("no final report");
  });
});
