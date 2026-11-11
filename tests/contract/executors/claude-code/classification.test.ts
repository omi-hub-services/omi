// Contract: Claude Code stream-json output (secret-free fixtures) -> neutral outcome.
//
// Provenance of the fixtures (see tests/fixtures/executors/claude-code/README.md):
//  - success, cancelled and unsupported-model reproduce the event sequences and the
//    exit/subtype/is_error combinations recorded by the OMI-002 live run (ADR-0013).
//  - usage-limit, auth-failure and unsupported-effort are SYNTHETIC: no real limit, logout or
//    bad-effort run was captured. They follow the CLI's documented wording, so a green test here
//    proves the classifier, not the real CLI. Re-capture them with the live test on upgrade.
import { describe, expect, it } from "vitest";
import {
  classifyClaudeRun,
  type ClaudeRunFacts,
} from "../../../../src/infrastructure/executors/claude-code/claude-code-classifier.js";
import { ClaudeStreamState } from "../../../../src/infrastructure/executors/claude-code/claude-code-stream.js";
import { fixture } from "./fake-claude-cli.js";

function classify(stdout: string, facts: Partial<ClaudeRunFacts> = {}) {
  const state = new ClaudeStreamState();
  for (const line of stdout.split("\n")) state.ingest(line);
  const summary = state.summary();
  return {
    summary,
    classification: classifyClaudeRun(summary, {
      exitCode: 0,
      signal: null,
      cancelRequested: false,
      timedOut: false,
      stdoutOverflow: false,
      stderr: "",
      ...facts,
    }),
  };
}

describe("success", () => {
  it("is exit 0 + subtype success + no is_error, on a subscription login", () => {
    const { summary, classification } = classify(fixture("success.stream.jsonl"));
    expect(classification).toMatchObject({
      outcome: "succeeded",
      reason: "completed",
      authMode: "subscription",
    });
    expect(summary.toolsUsed).toEqual(["Read"]);
    expect(summary.init).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(summary.result).toMatchObject({ numTurns: 2, text: "The codename is BLUE-HERON-42." });
  });

  it("is not changed by an informational rate-limit event", () => {
    const { summary } = classify(fixture("success.stream.jsonl"));
    expect(summary.quota).toMatchObject({ status: "allowed", limitType: "five_hour" });
  });

  it("is not misread as a limit because the answer talks about limits", () => {
    const stdout = fixture("success.stream.jsonl").replace(
      "The codename is BLUE-HERON-42.",
      "You've hit your limit of 3 retries; usage limit reached? Not an error.",
    );
    expect(classify(stdout).classification.outcome).toBe("succeeded");
  });

  it("is not trusted on the exit code alone", () => {
    const { classification } = classify(fixture("success.stream.jsonl"), { exitCode: 1 });
    expect(classification).toMatchObject({ outcome: "failed", reason: "nonzero_exit" });
  });

  it("is not trusted on subtype alone: subtype success with is_error true is a failure", () => {
    const stdout = fixture("success.stream.jsonl").replace('"is_error":false', '"is_error":true');
    expect(classify(stdout, { exitCode: 0 }).classification).toMatchObject({
      outcome: "failed",
      reason: "result_reported_error",
    });
  });

  it("is not trusted when the CLI was killed by a signal", () => {
    const { classification } = classify(fixture("success.stream.jsonl"), {
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(classification.outcome).toBe("failed");
  });

  it("fails when the run was billed to something other than the subscription login", () => {
    const stdout = fixture("success.stream.jsonl").replace(
      '"apiKeySource":"none"',
      '"apiKeySource":"ANTHROPIC_API_KEY"',
    );
    expect(classify(stdout).classification).toMatchObject({
      outcome: "failed",
      reason: "api_key_auth_detected",
      authMode: "api-key",
    });
  });

  it("records an effort the CLI reports at startup, and only a valid level", () => {
    expect(classify(fixture("success-effort-reported.stream.jsonl")).summary.init).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
    });
    const bogus = fixture("success-effort-reported.stream.jsonl").replace(
      '"effort":"high"',
      '"effort":"turbo"',
    );
    expect(classify(bogus).summary.init?.effort).toBeUndefined();
  });
});

describe("cancel and timeout", () => {
  it("a requested cancel is cancelled even though the CLI exits 0", () => {
    const { classification } = classify(fixture("cancelled.stream.jsonl"), {
      cancelRequested: true,
    });
    expect(classification.outcome).toBe("cancelled");
  });

  it("the same output without a cancel request is a failure, not a cancel", () => {
    const { classification } = classify(fixture("cancelled.stream.jsonl"));
    expect(classification).toMatchObject({ outcome: "failed", reason: "result_reported_error" });
  });

  it("a run that finished successfully despite a late cancel request stays succeeded", () => {
    const { classification } = classify(fixture("success.stream.jsonl"), {
      cancelRequested: true,
    });
    expect(classification.outcome).toBe("succeeded");
  });

  it("a timeout is reported as timed-out, not as a CLI error", () => {
    const { classification } = classify(fixture("cancelled.stream.jsonl"), { timedOut: true });
    expect(classification.outcome).toBe("timed-out");
  });

  it("a stdout overflow is a failure whatever the stream says", () => {
    const { classification } = classify(fixture("success.stream.jsonl"), {
      stdoutOverflow: true,
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(classification).toMatchObject({ outcome: "failed", reason: "output_limit_exceeded" });
  });
});

describe("usage limit", () => {
  it("is recognised from a rejected rate-limit event and a 429 result", () => {
    const { classification } = classify(fixture("usage-limit.stream.jsonl"), { exitCode: 1 });
    expect(classification).toMatchObject({
      outcome: "usage-limit",
      reason: "usage_limit_reached",
      quota: { limitType: "five_hour", resetsAt: 1794310800 },
    });
  });

  it("is recognised from the legacy `|epoch` message and reads the reset time from it", () => {
    const { classification } = classify(fixture("usage-limit-legacy.stream.jsonl"), {
      exitCode: 1,
    });
    expect(classification).toMatchObject({
      outcome: "usage-limit",
      quota: { resetsAt: 1794310800 },
    });
  });

  it("a later 'allowed' event does not hide an earlier rejection", () => {
    const stdout = [
      fixture("usage-limit.stream.jsonl").trimEnd(),
      fixture("success.stream.jsonl")
        .split("\n")
        .find((l) => l.includes("rate_limit_event")),
    ].join("\n");
    expect(classify(stdout, { exitCode: 1 }).summary.quota?.status).toBe("rejected");
  });

  it("keeps the diagnostic short and carries no raw stream", () => {
    const { classification } = classify(fixture("usage-limit.stream.jsonl"), { exitCode: 1 });
    expect(classification.diagnostic).toBe("You've hit your limit · resets 3pm");
  });
});

describe("login", () => {
  it("is recognised from a 401 result", () => {
    const { classification } = classify(fixture("auth-failure.stream.jsonl"), { exitCode: 1 });
    expect(classification).toMatchObject({ outcome: "auth-required", reason: "login_required" });
  });

  it("is recognised from stderr alone when no stream was produced", () => {
    const { classification } = classify("", {
      exitCode: 1,
      stderr: fixture("auth-not-logged-in.stderr.txt"),
    });
    expect(classification.outcome).toBe("auth-required");
  });

  it("is told apart from a usage limit", () => {
    const login = classify(fixture("auth-failure.stream.jsonl"), { exitCode: 1 });
    const limit = classify(fixture("usage-limit.stream.jsonl"), { exitCode: 1 });
    expect(login.classification.outcome).not.toBe(limit.classification.outcome);
  });
});

describe("unsupported model or effort", () => {
  it("an unknown model is subtype success with is_error true, exit 1 (ADR-0013 finding 1)", () => {
    const { summary, classification } = classify(fixture("unsupported-model.stream.jsonl"), {
      exitCode: 1,
      stderr: fixture("unsupported-model.stderr.txt"),
    });
    expect(summary.result).toMatchObject({ subtype: "success", isError: true });
    expect(classification).toMatchObject({
      outcome: "unsupported-model-or-effort",
      reason: "unsupported_model",
    });
  });

  it("is recognised from the stderr tag alone", () => {
    const { classification } = classify("", {
      exitCode: 1,
      stderr: fixture("unsupported-model.stderr.txt"),
    });
    expect(classification.reason).toBe("unsupported_model");
  });

  it("an invalid effort is recognised from the argument error on stderr", () => {
    const { classification } = classify("", {
      exitCode: 1,
      stderr: fixture("unsupported-effort.stderr.txt"),
    });
    expect(classification).toMatchObject({
      outcome: "unsupported-model-or-effort",
      reason: "unsupported_effort",
    });
  });

  it("is never confused with a quota or login error", () => {
    const model = classify(fixture("unsupported-model.stream.jsonl"), { exitCode: 1 });
    expect(model.classification.outcome).not.toBe("usage-limit");
    expect(model.classification.outcome).not.toBe("auth-required");
  });
});

describe("malformed output", () => {
  it("unparsable lines make an otherwise empty stream malformed", () => {
    const { summary, classification } = classify(fixture("malformed.stream.jsonl"));
    expect(summary.unparsedLines).toBe(4);
    expect(classification).toMatchObject({
      outcome: "malformed-output",
      reason: "unparsed_stdout",
    });
  });

  it("a stream that ends without a result event is malformed when the CLI exited 0", () => {
    const { classification } = classify(fixture("truncated.stream.jsonl"));
    expect(classification).toMatchObject({
      outcome: "malformed-output",
      reason: "missing_result_event",
    });
  });

  it("the same truncated stream with a non-zero exit is an ordinary failure", () => {
    const { classification } = classify(fixture("truncated.stream.jsonl"), { exitCode: 1 });
    expect(classification).toMatchObject({ outcome: "failed", reason: "exit_without_result" });
  });

  it("a result event without its required fields is malformed", () => {
    const { classification } = classify(fixture("invalid-result.stream.jsonl"));
    expect(classification).toMatchObject({
      outcome: "malformed-output",
      reason: "invalid_result_event",
    });
  });

  it("a stray non-JSON line fails an otherwise successful run (fail closed on CLI drift)", () => {
    const stdout = `${fixture("success.stream.jsonl")}unexpected banner line\n`;
    expect(classify(stdout).classification).toMatchObject({
      outcome: "malformed-output",
      reason: "unparsed_stdout",
    });
  });

  it("a successful stream without an init event is malformed", () => {
    const stdout = fixture("success.stream.jsonl")
      .split("\n")
      .filter((line) => !line.includes('"subtype":"init"'))
      .join("\n");
    expect(classify(stdout).classification).toMatchObject({
      outcome: "malformed-output",
      reason: "missing_init_event",
    });
  });

  it("blank lines and unknown event types are harmless", () => {
    const stdout = `\n${fixture("success.stream.jsonl")}\n{"type":"some_future_event","x":1}\n`;
    expect(classify(stdout).classification.outcome).toBe("succeeded");
  });
});

describe("diagnostics", () => {
  it("redacts secrets from the error text before it leaves the adapter", () => {
    const stdout = fixture("auth-failure.stream.jsonl").replace(
      "Invalid API key · Please run /login",
      "Invalid API key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 for fixture-user@example.invalid",
    );
    const { classification } = classify(stdout, { exitCode: 1 });
    expect(classification.diagnostic).not.toContain("sk-ant");
    expect(classification.diagnostic).not.toContain("example.invalid");
  });

  it("never copies the final answer of a successful run into the diagnostic", () => {
    expect(classify(fixture("success.stream.jsonl")).classification.diagnostic).toBeUndefined();
  });
});
