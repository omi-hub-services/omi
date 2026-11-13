import { describe, expect, it } from "vitest";
import type { Command } from "../../../../src/application/contracts/command.ts";
import { runCli } from "../../../../src/interfaces/cli/commands/create-program.ts";
import type { IpcOutcome } from "../../../../src/interfaces/ipc/protocol.ts";

const argv = [
  "merge-release",
  "--release",
  "r1",
  "--pr",
  "5",
  "--head-sha",
  "a".repeat(40),
  "--po",
  "po",
  "--check",
  "ci",
];
const context = (sendCommand: (request: { command: Command }) => Promise<IpcOutcome>) => ({
  sendCommand,
  defaultSocketPath: "/runtime.sock",
  timeoutMs: 100,
  version: "test",
  stdout: () => undefined,
  stderr: () => undefined,
});

describe("merge-release command", () => {
  it("sends the head-pinned release merge through IPC", async () => {
    const calls: Command[] = [];
    const code = await runCli(
      argv,
      context((request) => {
        calls.push(request.command);
        return Promise.resolve({ ok: true, result: { status: "done" } });
      }),
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        schemaVersion: 1,
        command: "release.merge",
        release: "r1",
        prNumber: 5,
        expectedHeadSha: "a".repeat(40),
        poActors: ["po"],
        requiredChecks: ["ci"],
      },
    ]);
  });

  it("exits with the refusal when the runtime refuses, after one call", async () => {
    let calls = 0;
    const code = await runCli(
      argv,
      context(() => {
        calls++;
        return Promise.resolve({
          ok: false,
          error: { code: "COMMAND_REFUSED", message: "RELEASE_MERGE_REFUSED: gate: HEAD_MOVED" },
        });
      }),
    );
    expect(code).toBe(4);
    expect(calls).toBe(1);
  });

  it("refuses a missing PO login without IPC", async () => {
    let calls = 0;
    const code = await runCli(
      argv.filter((arg, i) => arg !== "--po" && argv[i - 1] !== "--po"),
      context(() => {
        calls++;
        return Promise.resolve({ ok: true, result: {} });
      }),
    );
    expect(code).toBe(2);
    expect(calls).toBe(0);
  });
});
