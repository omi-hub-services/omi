import { describe, expect, it } from "vitest";
import { runCli } from "../../../../src/interfaces/cli/commands/create-program.ts";

describe("Coordinator CLI", () => {
  it.each([
    [
      ["dispatch", "--run", "r", "--step", "implement", "--notes", "notes.md"],
      { command: "dispatch", runId: "r", stepId: "implement", notes: "Inspect timeout." },
    ],
    [["worker-report", "--attempt", "a"], { command: "worker-report", attemptId: "a" }],
    [
      ["commit-worker", "--attempt", "a", "--message-file", "notes.md"],
      { command: "commit-worker", attemptId: "a", message: "Inspect timeout." },
    ],
    [
      ["review-comment", "--pr", "42", "--file", "notes.md"],
      { command: "review-comment", prNumber: 42, body: "Inspect timeout." },
    ],
  ])("routes %j through the typed runtime command", async (argv, expected) => {
    const calls: unknown[] = [];
    const code = await runCli(argv, {
      sendCommand: (input) => {
        calls.push(input.command);
        return Promise.resolve({ ok: true, result: {} });
      },
      defaultSocketPath: "/unused",
      timeoutMs: 100,
      version: "0",
      stdout: () => undefined,
      stderr: () => undefined,
      readText: () => Promise.resolve("Inspect timeout."),
    });
    expect(code).toBe(0);
    expect(calls).toEqual([{ schemaVersion: 1, ...expected }]);
  });
});
