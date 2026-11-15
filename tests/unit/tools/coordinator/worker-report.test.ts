import { describe, expect, it } from "vitest";
import {
  formatReport,
  isCodexLog,
  newestLogCommand,
  parseClaudeReport,
  parseCodexReport,
  truncateOverCapSummary,
  validateWorkerResult,
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

describe("validateWorkerResult", () => {
  const doc = {
    schemaVersion: 1,
    runId: "repo-264",
    stepId: "implement",
    attemptId: "repo-264-implement-1",
    status: "succeeded",
    summary: "Evidence",
    artifacts: [],
    checks: [],
    skillsApplied: [],
    findings: [],
  };
  const fence = "```";
  const block = (d: unknown) => `${fence}json\n${JSON.stringify(d)}\n${fence}`;

  it("uses the framework extractor: prose plus one fenced json document is a result", () => {
    expect(validateWorkerResult(`AC-1: met — ok\n\n${block(doc)}\n`).success).toBe(true);
  });

  it("refuses two different fenced documents", () => {
    expect(
      validateWorkerResult(`${block(doc)}\n${block({ ...doc, status: "failed" })}`).success,
    ).toBe(false);
  });
});

describe("truncateOverCapSummary (OMI-176)", () => {
  const doc = (over: Record<string, unknown>) =>
    JSON.stringify({
      schemaVersion: 1,
      runId: "repo-1",
      stepId: "architect",
      attemptId: "repo-1-architect-1",
      status: "succeeded",
      summary: "x",
      artifacts: [],
      checks: [],
      skillsApplied: [],
      findings: [],
      ...over,
    });
  const log = "omi-173-minibox-20261115-101010-architect-1-k3x9a1b2c3.jsonl";
  const long = Array.from({ length: 120 }, (_, i) => `line ${String(i)} ${"w".repeat(30)}`).join(
    "\n",
  );

  it("cuts at a line boundary below the cap and ends with the log pointer", () => {
    expect(long.length).toBeGreaterThan(4000);
    const cut = truncateOverCapSummary(doc({ summary: long }), log);
    expect(cut).not.toBeNull();
    const ok = validateWorkerResult(cut ?? "");
    expect(ok.success).toBe(true);
    const summary = ok.success ? ok.data.summary : "";
    expect(summary.length).toBeLessThanOrEqual(4000);
    expect(summary.split("\n").at(-1)).toBe(
      `… truncated (${String(long.length)} characters); full text: ${log}`,
    );
    expect(long.startsWith(summary.split("\n").slice(0, -1).join("\n"))).toBe(true);
  });

  it("does not touch a report with another contract failure, even when the summary is long", () => {
    expect(truncateOverCapSummary(doc({ summary: long, status: "great" }), log)).toBeNull();
  });

  it("does not touch a valid report", () => {
    expect(truncateOverCapSummary(doc({}), log)).toBeNull();
  });
});
