import { describe, expect, it } from "vitest";
import { commandSchema, type Command } from "../../../../src/application/contracts/command.ts";
import { runCli } from "../../../../src/interfaces/cli/commands/create-program.ts";

describe("release preparation and publication commands", () => {
  it.each([
    ["prepare-release", "release.prepare", []],
    ["publish-release", "release.publish", ["--pr", "5"]],
  ])("sends %s through IPC with an optional title", async (name, route, extra) => {
    const calls: Command[] = [];
    const output: string[] = [];
    const code = await runCli([name, "--release", "r1", ...extra, "--title", "Release one"], {
      sendCommand: ({ command }) => {
        calls.push(command);
        return Promise.resolve({ ok: true, result: { prNumber: 5, headSha: "a".repeat(40) } });
      },
      defaultSocketPath: "/runtime.sock",
      timeoutMs: 100,
      version: "test",
      stdout: (text) => output.push(text),
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        schemaVersion: 1,
        command: route,
        release: "r1",
        title: "Release one",
        ...(name === "publish-release" ? { prNumber: 5 } : {}),
      },
    ]);
    expect(output.join("")).toContain("a".repeat(40));
  });

  it.each(["release.prepare", "release.publish"])(
    "validates %s and rejects repository overrides",
    (command) => {
      const input = {
        schemaVersion: 1,
        command,
        release: "r1",
        ...(command === "release.publish" ? { prNumber: 5 } : {}),
      };
      expect(commandSchema.safeParse(input).success).toBe(true);
      expect(commandSchema.safeParse({ ...input, repository: "other/repo" }).success).toBe(false);
      expect(commandSchema.safeParse({ ...input, release: "../bad" }).success).toBe(false);
      if (command === "release.publish")
        expect(commandSchema.safeParse({ ...input, prNumber: 0 }).success).toBe(false);
    },
  );

  it.each([
    ["prepare-release", []],
    ["publish-release", ["--pr", "5"]],
  ])("preserves a named %s refusal as JSON without a title", async (name, extra) => {
    const output: string[] = [];
    const calls: Command[] = [];
    expect(
      await runCli([name, "--release", "r1", ...extra, "--json"], {
        sendCommand: ({ command }) => {
          calls.push(command);
          return Promise.resolve({
            ok: false,
            error: { code: "COMMAND_REFUSED", message: "HTTP_503" },
          });
        },
        defaultSocketPath: "/runtime.sock",
        timeoutMs: 100,
        version: "test",
        stdout: (text) => output.push(text),
        stderr: () => undefined,
      }),
    ).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("title");
    expect(JSON.parse(output.join(""))).toMatchObject({
      ok: false,
      error: { code: "COMMAND_REFUSED", message: "HTTP_503" },
    });
  });

  it.each([
    ["prepare-release", "--release", "../bad"],
    ["publish-release", "--release", "r1", "--pr", "1e3"],
    ["publish-release", "--release", "r1"],
    ["prepare-release", "--release", "r1", "--repository", "other/repo"],
  ])("rejects invalid arguments without IPC: %s %s %s", async (...argv) => {
    let calls = 0;
    expect(
      await runCli(argv, {
        sendCommand: () => {
          calls++;
          return Promise.resolve({ ok: true, result: {} });
        },
        defaultSocketPath: "/runtime.sock",
        timeoutMs: 100,
        version: "test",
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).toBe(2);
    expect(calls).toBe(0);
  });
});
