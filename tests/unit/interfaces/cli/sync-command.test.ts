import { expect, it } from "vitest";
import { commandSchema } from "../../../../src/application/contracts/command.ts";
import { runCli } from "../../../../src/interfaces/cli/commands/create-program.ts";

const report = {
  schemaVersion: 1,
  reconcile: { entries: [], githubUnavailable: false },
  attempts: [],
  snapshots: [],
  githubUnavailable: false,
};

it("accepts only versioned sync commands with an optional explicit Issue selection", () => {
  expect(commandSchema.safeParse({ schemaVersion: 1, command: "sync" }).success).toBe(true);
  expect(
    commandSchema.safeParse({ schemaVersion: 1, command: "sync", issueNumbers: [1, 2] }).success,
  ).toBe(true);
  for (const input of [
    { command: "sync" },
    { schemaVersion: 2, command: "sync" },
    { schemaVersion: 1, command: "sync", issueNumbers: [] },
    { schemaVersion: 1, command: "sync", issueNumbers: [0] },
    { schemaVersion: 1, command: "sync", all: true },
  ])
    expect(commandSchema.safeParse(input).success).toBe(false);
});

async function cli(args: string[], result: unknown = report) {
  const sent: unknown[] = [];
  let out = "",
    err = "";
  const code = await runCli(args, {
    sendCommand: (request) => {
      sent.push(request.command);
      return Promise.resolve({ ok: true, result });
    },
    defaultSocketPath: "/x",
    timeoutMs: 100,
    version: "test",
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  });
  return { code, out, err, sent };
}

it.each([
  [["sync", "--json"], { schemaVersion: 1, command: "sync" }],
  [
    ["sync", "--issues", "1", "2", "--json"],
    { schemaVersion: 1, command: "sync", issueNumbers: [1, 2] },
  ],
])("sends %j through IPC", async (args, command) => {
  const result = await cli(args);
  expect(result.code).toBe(0);
  expect(result.sent).toEqual([command]);
  expect(JSON.parse(result.out)).toMatchObject({ schemaVersion: 1, result: report });
});

it.each(["0", "1e3", "1.5", "10000000000"])("rejects Issue %s before IPC", async (issue) => {
  const result = await cli(["sync", "--issues", issue]);
  expect(result.code).toBe(2);
  expect(result.sent).toEqual([]);
});

it.each(["GITHUB_UNAVAILABLE", "RATE_LIMITED"] as const)(
  "preserves the report with classification %s and a nonzero exit",
  async (code) => {
    const result = await cli(["sync", "--json"], { ...report, code, githubUnavailable: true });
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out)).toMatchObject({
      ok: false,
      exitCode: 4,
      error: { code },
      result: { githubUnavailable: true },
    });
  },
);

it("rejects a malformed runtime report", async () => {
  expect((await cli(["sync"], { schemaVersion: 2 })).code).toBe(5);
});
