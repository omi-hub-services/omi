import { describe, expect, it } from "vitest";
import {
  buildWorkerEnv,
  classify,
  diagnosticCategory,
  parseStreamLine,
  redactText,
  summarizeEvent,
  type CliRun,
} from "../../../live/codex-cli/codex-cli-process.js";

function completed(overrides: Partial<CliRun> = {}): CliRun {
  return {
    exitCode: 0,
    signal: null,
    durationMs: 1,
    events: [{ type: "turn.completed" }],
    unparsedStdoutLines: 0,
    stderr: "",
    groupAliveAtClose: false,
    timedOut: false,
    outputLimitExceeded: false,
    ...overrides,
  };
}

describe("Codex PoC boundaries", () => {
  it("drops API credentials, provider overrides and inherited session configuration", () => {
    const env = buildWorkerEnv(
      {
        PATH: "/bin",
        HOME: "/home/test",
        OPENAI_API_KEY: "secret",
        CODEX_API_KEY: "secret",
        OPENAI_BASE_URL: "https://invalid",
        CODEX_HOME: "/wrong",
        CODEX_THREAD_ID: "parent",
        ANTHROPIC_API_KEY: "secret",
      },
      "/profile",
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/profile" });
  });
  it("rejects malformed and untyped JSONL while allowing extensible typed events", () => {
    for (const line of ["", "not json", "[]", "null", '{"type":5}', "{}"]) {
      expect(parseStreamLine(line)).toBeUndefined();
    }
    expect(parseStreamLine('{"type":"turn.completed","usage":{"input_tokens":3}}')?.type).toBe(
      "turn.completed",
    );
  });
  it("does not treat exit zero, transport errors or a deadline as success", () => {
    expect(classify(completed())).toBe("success");
    expect(classify(completed({ events: [] }))).toBe("error");
    expect(classify(completed({ exitCode: 1 }))).toBe("error");
    expect(classify(completed({ events: [{ type: "turn.completed" }, { type: "error" }] }))).toBe(
      "error",
    );
    expect(classify(completed({ timedOut: true }))).toBe("error");
    expect(classify(completed({ outputLimitExceeded: true }))).toBe("error");
    expect(classify(completed({ unparsedStdoutLines: 1 }))).toBe("error");
    expect(classify(completed({ groupAliveAtClose: true }))).toBe("error");
    expect(classify(completed({ events: [{ type: "turn.failed" }] }))).toBe("error");
  });
  it("distinguishes cancellation from completion races and hard timeout", () => {
    const cancel = {
      signal: "SIGINT" as const,
      afterMs: 1,
      exitAfterSignalMs: 2,
      escalated: false,
    };
    expect(classify(completed({ cancel, exitCode: null, signal: "SIGINT", events: [] }))).toBe(
      "cancelled",
    );
    expect(classify(completed({ cancel }))).toBe("success");
    expect(classify(completed({ cancel, timedOut: true }))).toBe("error");
  });
  it("scrubs credential forms and drops all event content from evidence", () => {
    const secret = "synthetic-token-value";
    const text = `Bearer ${secret} sk-example-key {"refresh_token":"${secret}"} access_token=${secret} id_token=${secret}`;
    expect(redactText(text)).not.toContain(secret);
    expect(redactText(text)).not.toContain("sk-example-key");
    const jwt = "eyJhbGciOiJub25lIn0synthetic.payload.signature";
    expect(redactText(jwt)).not.toContain(jwt);
    expect(redactText("t".repeat(50))).not.toContain("t".repeat(50));
    expect(
      summarizeEvent({ type: "item.completed", item: { text, command: text }, thread_id: secret }),
    ).toEqual({ type: "item.completed" });
    expect(summarizeEvent({ type: secret })).toEqual({ type: "unknown" });
  });
  it("maps diagnostics to fixed categories without reflecting stderr", () => {
    expect(diagnosticCategory("Read-only file system (os error 30) secret")).toBe(
      "read-only-filesystem",
    );
    expect(diagnosticCategory("Permission denied: secret")).toBe("permission-denied");
    expect(diagnosticCategory("Failed to parse output schema: secret")).toBe("invalid-schema");
    expect(diagnosticCategory("connection failed: secret")).toBe("network");
    expect(diagnosticCategory("unknown secret")).toBe("other");
    expect(diagnosticCategory("")).toBe("none");
  });
});
