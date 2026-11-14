import { describe, expect, it } from "vitest";
import { commandSchema, type Command } from "../../../../src/application/contracts/command.ts";
import { runCli } from "../../../../src/interfaces/cli/commands/create-program.ts";

const environment = (sendCommand: (c: Command) => void, output: string[] = []) => ({
  sendCommand: ({ command }: { command: Command }) => {
    sendCommand(command);
    return Promise.resolve({ ok: true as const, result: { status: "verified" } });
  },
  defaultSocketPath: "/runtime.sock",
  timeoutMs: 100,
  version: "test",
  stdout: (text: string) => output.push(text),
  stderr: () => undefined,
});

describe("deploy command", () => {
  it("sends only the configured target id through IPC", async () => {
    const calls: Command[] = [];
    expect(
      await runCli(
        ["deploy", "--target", "app-r1"],
        environment((c) => calls.push(c)),
      ),
    ).toBe(0);
    expect(calls).toEqual([{ schemaVersion: 1, command: "deploy", target: "app-r1" }]);
  });

  it("validates the IPC command and refuses approval, repository or pipeline overrides", () => {
    const input = { schemaVersion: 1, command: "deploy", target: "app-r1" };
    expect(commandSchema.safeParse(input).success).toBe(true);
    for (const extra of [
      { approvalId: "a" },
      { repository: "x/y" },
      { environment: "prod" },
      { workflow: "x.yml" },
    ])
      expect(commandSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(commandSchema.safeParse({ ...input, target: "../bad" }).success).toBe(false);
  });

  it.each([[["deploy"]], [["deploy", "--target", "a", "--approval", "x"]]])(
    "rejects invalid arguments without IPC: %j",
    async (argv) => {
      const calls: Command[] = [];
      expect(
        await runCli(
          argv,
          environment((c) => calls.push(c)),
        ),
      ).toBe(2);
      expect(calls).toHaveLength(0);
    },
  );
});
