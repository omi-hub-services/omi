import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCodexRun } from "../../../../src/infrastructure/executors/codex/codex-classifier.js";
import { CodexStreamState } from "../../../../src/infrastructure/executors/codex/codex-stream.js";
import type { ProcessExit } from "../../../../src/infrastructure/processes/supervised-process.js";
import { fixture } from "./fake-codex-cli.js";

function facts(overrides: Partial<ProcessExit> = {}): ProcessExit {
  return {
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stderr: "",
    cancelRequested: false,
    timedOut: false,
    stdoutOverflow: false,
    escalated: false,
    leftoverProcessesKilled: false,
    ...overrides,
  };
}
function stream(text: string): CodexStreamState {
  const state = new CodexStreamState();
  for (const line of text.split("\n")) state.ingest(line);
  return state;
}
function classify(text: string, overrides: Partial<ProcessExit> = {}) {
  return classifyCodexRun(stream(text).summary(), facts(overrides));
}

describe("Codex parser and classification invariants", () => {
  it("requires completion, a thread, a zero exit, no signal and no error for success", () => {
    const success = fixture("success.stream.jsonl");
    expect(classify(success).outcome).toBe("succeeded");
    expect(classify(success, { exitCode: 1 }).outcome).toBe("failed");
    expect(classify(success, { signal: "SIGTERM" }).outcome).toBe("failed");
    expect(classify('{"type":"turn.completed"}').reason).toBe("missing_thread_event");
    expect(classify('{"type":"thread.started","thread_id":"t"}').reason).toBe(
      "missing_completion_event",
    );
    expect(classify(success + '{"type":"error","message":"network failed"}').outcome).toBe(
      "failed",
    );
    expect(
      classify(success + '{"type":"turn.failed","error":{"message":"network failed"}}').outcome,
    ).toBe("failed");
    expect(classify(success + "not json").outcome).toBe("malformed-output");
  });

  it("classifies a completion racing with cancel as success, and transport limits as failure", () => {
    const success = fixture("success.stream.jsonl");
    expect(classify(success, { cancelRequested: true }).outcome).toBe("succeeded");
    expect(classify(success, { stdoutOverflow: true }).reason).toBe("output_limit_exceeded");
    expect(
      classify("", { exitCode: 1, cancelRequested: true, stderr: "usage limit" }).outcome,
    ).toBe("cancelled");
    expect(classify("", { exitCode: 1, timedOut: true, stderr: "usage limit" }).outcome).toBe(
      "timed-out",
    );
  });

  it("keeps network and unknown errors distinct from auth, quota and unsupported settings", () => {
    for (const stderr of [
      "connection reset",
      "HTTP 429 from proxy",
      "see --effort in help",
      "please run codex --help",
      "unknown failure",
      "server error 500",
    ]) {
      expect(classify("", { exitCode: 1, stderr }).outcome).toBe("failed");
    }
    expect(
      classify("", { exitCode: 1, stderr: fixture("unsupported-effort.stderr.txt") }).reason,
    ).toBe("unsupported_effort");
    expect(
      classify(fixture("unsupported-model.stream.jsonl"), {
        exitCode: 1,
        stderr: "usage limit; authentication required",
      }).reason,
    ).toBe("unsupported_model");
    expect(
      classify(fixture("auth-failure.stream.jsonl"), { exitCode: 1, stderr: "usage limit" })
        .outcome,
    ).toBe("auth-required");
  });

  it.each([
    "null",
    "[]",
    "{}",
    '{"type":5}',
    '{"type":"thread.started","thread_id":12}',
    '{"type":"item.started","item":{"id":"x"}}',
    '{"type":"turn.failed","error":{}}',
    '{"type":"error","message":5}',
    '{"type":"rate_limits.updated","rateLimits":{"primary":{"usedPercent":"100"}}}',
  ])("rejects malformed external data: %s", (line) => {
    const state = new CodexStreamState();
    expect(state.ingest(line)).toEqual([{ kind: "diagnostic", code: "unparsed-output" }]);
    expect(state.summary().unparsedLines).toBe(1);
  });

  it("accepts typed unknown events without forwarding contents and counts blank lines separately", () => {
    const state = new CodexStreamState();
    expect(state.ingest("  ")).toEqual([]);
    expect(state.ingest('{"type":"future.event","secret":"synthetic-private"}')).toEqual([]);
    expect(state.summary()).toMatchObject({ eventCount: 1, unparsedLines: 0 });
    expect(JSON.stringify(state.summary())).not.toContain("synthetic-private");
  });

  it("handles the coordinator rate-limit snapshot without claiming 99% is exhausted", () => {
    const snapshot: unknown = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../../../fixtures/coordinator/codex-rate-limits.json"),
        "utf8",
      ),
    );
    const state = new CodexStreamState();
    const signals = state.ingest(
      JSON.stringify({ type: "rate_limits.updated", ...(snapshot as Record<string, unknown>) }),
    );
    expect(signals).toEqual([
      { kind: "quota-signal", status: "allowed", limitType: "primary", resetsAt: 1794310800 },
      { kind: "quota-signal", status: "warning", limitType: "secondary", resetsAt: 1794657600 },
    ]);
    expect(classifyCodexRun(state.summary(), facts({ exitCode: 1 })).outcome).toBe("failed");
  });

  it("preserves an exhausted quota after later allowed windows", () => {
    const state = stream(fixture("usage-limit.stream.jsonl"));
    state.ingest(
      '{"type":"rate_limits.updated","rateLimits":{"primary":{"usedPercent":1,"windowDurationMins":300,"resetsAt":2000000000}}}',
    );
    expect(state.summary().quota).toEqual({
      status: "rejected",
      limitType: "secondary",
      resetsAt: 1794657600,
    });
  });

  it("normalises tool item types without forwarding commands, filenames or MCP payload", () => {
    const state = new CodexStreamState();
    for (const type of ["file_change", "web_search", "mcp_tool_call"]) {
      const item = {
        id: type,
        type,
        command: "synthetic-private",
        arguments: { secret: "synthetic-private" },
      };
      expect(state.ingest(JSON.stringify({ type: "item.completed", item }))).toEqual([
        { kind: "tool-use", tool: type },
      ]);
      expect(state.ingest(JSON.stringify({ type: "item.updated", item }))).toEqual([]);
    }
    expect(JSON.stringify(state.summary())).not.toContain("synthetic-private");
  });
});
