import { describe, expect, it } from "vitest";
import {
  runCli,
  type CliEnvironment,
} from "../../../../src/interfaces/cli/commands/create-program.ts";

const pending = { id: "req-1", version: 0, status: "pending", subjectId: "task-1" };

function setup(outcome: unknown = { ok: true, result: pending }) {
  const sent: unknown[] = [];
  let out = "";
  let err = "";
  const environment = {
    sendCommand: (request: { command: unknown }) => {
      sent.push(request.command);
      return Promise.resolve(outcome);
    },
    defaultSocketPath: "/x",
    timeoutMs: 100,
    version: "0",
    stdout: (text: string) => {
      out += text;
    },
    stderr: (text: string) => {
      err += text;
    },
  } as unknown as CliEnvironment;
  return { run: (args: string[]) => runCli(args, environment), sent, output: () => ({ out, err }) };
}

describe("approvals request", () => {
  it.each(["business", "deploy"])(
    "sends a %s request over IPC and prints id and version",
    async (kind) => {
      const s = setup();
      expect(await s.run(["approvals", "request", "task-1", "--kind", kind])).toBe(0);
      expect(s.sent).toEqual([
        { schemaVersion: 1, command: "approval.request", subjectId: "task-1", kind },
      ]);
      expect(s.output().out).toContain("req-1");
      expect(s.output().out).toContain("version 0");
    },
  );

  it("returns the request id and version in JSON", async () => {
    const s = setup();
    expect(await s.run(["--json", "approvals", "request", "task-1", "--kind", "business"])).toBe(0);
    expect(JSON.parse(s.output().out)).toMatchObject({
      ok: true,
      result: { id: "req-1", version: 0 },
    });
  });

  it.each([
    ["an unsupported kind", ["approvals", "request", "task-1", "--kind", "release"]],
    ["a missing kind", ["approvals", "request", "task-1"]],
    ["a bad subject id", ["approvals", "request", "../x", "--kind", "business"]],
    [
      "a decision flag",
      ["approvals", "request", "task-1", "--kind", "business", "--decision", "approved"],
    ],
    ["an approved flag", ["approvals", "request", "task-1", "--kind", "business", "--approved"]],
  ])("refuses %s without contacting the runtime", async (_name, args) => {
    const s = setup();
    expect(await s.run(args)).toBe(2);
    expect(s.sent).toEqual([]);
  });

  it("reports a runtime refusal", async () => {
    const s = setup({
      ok: false,
      error: { code: "APPROVAL_REFUSED", message: "Approval refused: SUBJECT_NOT_FOUND" },
    });
    expect(await s.run(["approvals", "request", "task-9", "--kind", "deploy"])).not.toBe(0);
    expect(s.output().err + s.output().out).toContain("SUBJECT_NOT_FOUND");
  });
});
