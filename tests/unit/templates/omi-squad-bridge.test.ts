import { describe, expect, it } from "vitest";
import { runCli } from "../../../src/interfaces/cli/commands/create-program.ts";
import type { CliEnvironment } from "../../../src/interfaces/cli/commands/create-program.ts";
import type { SendCommand } from "../../../src/interfaces/ipc/ipc-client.ts";
import {
  BridgeInputError,
  buildCliArgv,
  buildWslArgs,
  callCli,
  parseCliOutput,
  parseConfig,
  parseRequest,
  quoteWindowsCommandLine,
} from "../../../templates/bridges/claude-code/omi-squad/bridge.ts";
import type {
  BridgeConfig,
  BridgeRequest,
} from "../../../templates/bridges/claude-code/omi-squad/bridge.ts";
import { createFakeWsl, parseWindowsCommandLine } from "./wsl-fakes.ts";

const SHA = "a".repeat(40);
const AT = "2026-11-11T00:00:00.000Z";
const config: BridgeConfig = {
  distribution: "Ubuntu-24.04",
  repository: "/home/dev/my project/it's",
  shim: "/home/dev/my project/.omi-squad/bin/omi",
};

/** Values chosen to break naive quoting or a shell: spaces, quotes, backslashes, expansions. */
const NASTY = [
  "plain",
  "with space",
  'double " quote',
  "trailing backslash\\",
  'backslash before quote \\" end',
  "two trailing backslashes\\\\",
  "$HOME and $(id) and `id`",
  "glob * ? [a-z]",
  "%PATH% and ^ & | < > ;",
  "it's 'single'",
  "unicode é 日本語 🚀",
  "--looks-like-an-option",
  "-x",
  "a=b=c",
  "tab\there",
];

const requests: BridgeRequest[] = [
  { command: "status" },
  { command: "status", runId: "run-1" },
  { command: "plan", issueNumber: 35 },
  { command: "plan", issueNumber: 35, workflowId: "minimal-delivery" },
  { command: "dispatch", runId: "run-1", stepId: "implement" },
  { command: "wait", runId: "run-1", timeoutSeconds: 300 },
  { command: "pause", runId: "run-1", reason: "context is full" },
  { command: "resume", runId: "run-1" },
  {
    command: "deliver",
    runId: "run-1",
    prNumber: 128,
    reviewedHeadSha: SHA,
    requiredChecks: ["ci"],
  },
  {
    command: "deliver",
    runId: "run-1",
    prNumber: 128,
    reviewedHeadSha: SHA,
    requiredChecks: ["ci", "lint"],
    minimumNativeApprovals: 1,
  },
  { command: "handoff", reason: "new-session" },
  { command: "handoff", reason: "profile-switch", toProfile: "coordinator-b" },
];

describe("bridge argv is typed and carries no shell text", () => {
  it("builds the exact CLI arguments for every request kind", () => {
    expect(requests.map((request) => buildCliArgv(request).args)).toEqual([
      ["--json", "status"],
      ["--json", "status", "--run=run-1"],
      ["--json", "plan", "--issue=35"],
      ["--json", "plan", "--issue=35", "--workflow=minimal-delivery"],
      ["--json", "dispatch", "--run=run-1", "--step=implement"],
      ["--json", "wait", "--run=run-1", "--timeout=300"],
      ["--json", "pause", "--run=run-1", "--reason-stdin"],
      ["--json", "resume", "--run=run-1"],
      ["--json", "deliver", "--run=run-1", "--pr=128", `--head-sha=${SHA}`, "--check=ci"],
      [
        "--json",
        "deliver",
        "--run=run-1",
        "--pr=128",
        `--head-sha=${SHA}`,
        "--check=ci",
        "--check=lint",
        "--min-approvals=1",
      ],
      ["--json", "session", "new"],
      ["--json", "coordinator", "switch", "--to=coordinator-b"],
    ]);
  });

  it("sends a pause reason on stdin and never on the command line", () => {
    const reason = 'free text with "quotes", $(rm -rf /), newline\nand \\ backslash';
    const built = buildCliArgv(parseRequest({ command: "pause", runId: "run-1", reason }));
    expect(built.stdin).toBe(reason);
    expect(built.args.join(" ")).not.toContain("rm -rf");
    expect(built.args.join(" ")).not.toContain("quotes");
  });

  it("calls wsl.exe with --exec so the distro's shell never sees the arguments", () => {
    const args = buildWslArgs(config, ["--json", "status"]);
    expect(args).toEqual([
      "-d",
      "Ubuntu-24.04",
      "--cd",
      config.repository,
      "--exec",
      config.shim,
      "--json",
      "status",
    ]);
    expect(args).not.toContain("--");
  });
});

describe("quoting survives the Windows command line for every parameter the bridge sends", () => {
  it.each(NASTY)("round-trips the value %j in every string position", (value) => {
    // The distribution is validated to a safe pattern, so the free-form positions are the paths
    // and the check names; they are all attached with --flag=value.
    const wsl = buildWslArgs({ ...config, repository: `/home/${value}`, shim: `/bin/${value}` }, [
      "--json",
      "deliver",
      "--run=run-1",
      "--pr=1",
      `--head-sha=${SHA}`,
      `--check=${value}`,
    ]);
    expect(parseWindowsCommandLine(quoteWindowsCommandLine(wsl))).toEqual(wsl);
  });

  it("round-trips the argument vector of every request kind and the configured paths", () => {
    for (const request of requests) {
      const wsl = buildWslArgs(config, buildCliArgv(request).args);
      expect(parseWindowsCommandLine(quoteWindowsCommandLine(wsl))).toEqual(wsl);
    }
  });

  it("round-trips an empty argument and arguments made only of quotes and backslashes", () => {
    const args = ["", '"', '\\"', '\\\\"', "\\", "\\\\", '""', " "];
    expect(parseWindowsCommandLine(quoteWindowsCommandLine(args))).toEqual(args);
  });

  it("hands Windows one pre-quoted command line and Linux an array, never a shell", async () => {
    const request: BridgeRequest = {
      command: "deliver",
      runId: "run-1",
      prNumber: 1,
      reviewedHeadSha: SHA,
      requiredChecks: NASTY,
    };
    for (const platform of ["win32", "linux"] as const) {
      const wsl = createFakeWsl(() =>
        Promise.resolve({
          stdout: `${JSON.stringify({ schemaVersion: 1, ok: true, exitCode: 0, result: {} })}\n`,
          exitCode: 0,
        }),
      );
      await callCli(config, request, { spawn: wsl.spawn, platform });
      expect(wsl.executables).toEqual(["wsl.exe"]);
      expect(wsl.options).toMatchObject([
        { shell: false, windowsVerbatimArguments: platform === "win32" },
      ]);
      expect(wsl.calls).toMatchObject([
        {
          distribution: config.distribution,
          repository: config.repository,
          shim: config.shim,
          cliArgs: [
            "--json",
            "deliver",
            "--run=run-1",
            "--pr=1",
            `--head-sha=${SHA}`,
            ...NASTY.map((check) => `--check=${check}`),
          ],
        },
      ]);
    }
  });
});

describe("the CLI parses exactly the values the bridge sent", () => {
  async function parsedBy(request: BridgeRequest) {
    const sent: unknown[] = [];
    const sendCommand: SendCommand = (input) => {
      sent.push(input.command);
      const runtime = { schemaVersion: 1, state: "ready", runtimeVersion: "0", startedAt: AT };
      return Promise.resolve({
        ok: true,
        result:
          input.command.command === "status" && input.command.runId === undefined ? runtime : {},
      });
    };
    const environment: CliEnvironment = {
      sendCommand,
      defaultSocketPath: "/nowhere",
      timeoutMs: 1000,
      version: "0",
      stdout: () => undefined,
      stderr: () => undefined,
      readStdin: () => Promise.resolve(buildCliArgv(request).stdin),
    };
    const { args } = buildCliArgv(request);
    const exitCode = await runCli(args, environment);
    return { exitCode, command: sent[0] };
  }

  it.each(requests.map((request) => [JSON.stringify(request), request] as const))(
    "%s",
    async (_name, request) => {
      const { exitCode, command } = await parsedBy(request);
      expect(exitCode).toBe(0);
      expect(command).toMatchObject({
        command: request.command,
        ...(request.command === "plan" ? { issueNumber: request.issueNumber } : {}),
        ...(request.command === "pause" ? { reason: request.reason } : {}),
      });
    },
  );

  it.each(NASTY)(
    "keeps the check name %j intact, even when it looks like an option",
    async (name) => {
      const { exitCode, command } = await parsedBy({
        command: "deliver",
        runId: "run-1",
        prNumber: 7,
        reviewedHeadSha: SHA,
        requiredChecks: [name, "ci"],
      });
      expect(exitCode).toBe(0);
      expect(command).toMatchObject({ requiredChecks: [name.trim(), "ci"], prNumber: 7 });
    },
  );

  it("keeps a multi-line pause reason with quotes intact through stdin", async () => {
    const reason = 'line one\nline "two" $(id) \\';
    const { command } = await parsedBy({ command: "pause", runId: "run-1", reason });
    expect(command).toMatchObject({ command: "pause", reason });
  });
});

describe("request and config validation rejects anything outside the typed domain", () => {
  it.each([
    [{ command: "plan", issueNumber: 0 }],
    [{ command: "plan", issueNumber: 1.5 }],
    [{ command: "plan", issueNumber: "35" }],
    [{ command: "plan", issueNumber: 1, workflowId: "Has Space" }],
    [{ command: "plan", issueNumber: 1, extra: true }],
    [{ command: "dispatch", runId: "run 1", stepId: "implement" }],
    [{ command: "dispatch", runId: "run-1", stepId: "../x" }],
    [{ command: "dispatch", runId: "-rf", stepId: "implement" }],
    [{ command: "wait", runId: "run-1", timeoutSeconds: 0 }],
    [{ command: "wait", runId: "run-1", timeoutSeconds: 3601 }],
    [{ command: "pause", runId: "run-1", reason: "   " }],
    [{ command: "pause", runId: "run-1", reason: "x".repeat(501) }],
    [{ command: "pause", runId: "run-1", reason: "bad\u0000nul" }],
    [
      {
        command: "deliver",
        runId: "run-1",
        prNumber: 1,
        reviewedHeadSha: "abc",
        requiredChecks: ["ci"],
      },
    ],
    [{ command: "deliver", runId: "run-1", prNumber: 1, reviewedHeadSha: SHA, requiredChecks: [] }],
    [
      {
        command: "deliver",
        runId: "run-1",
        prNumber: 1,
        reviewedHeadSha: SHA,
        requiredChecks: ["a\nb"],
      },
    ],
    [
      {
        command: "deliver",
        runId: "run-1",
        prNumber: 1,
        reviewedHeadSha: SHA,
        requiredChecks: ["a\u0000b"],
      },
    ],
    [
      {
        command: "deliver",
        runId: "run-1",
        prNumber: 1,
        reviewedHeadSha: SHA,
        requiredChecks: [1],
      },
    ],
    [{ command: "handoff", reason: "profile-switch" }],
    [{ command: "handoff", reason: "profile-switch", toProfile: "Bad Profile" }],
    [{ command: "handoff", reason: "other" }],
    [{ command: "unknown" }],
    ["plan"],
    [null],
  ])("refuses the request %j", (raw) => {
    expect(() => parseRequest(raw)).toThrow(BridgeInputError);
  });

  it.each([
    [{ distribution: "Ubuntu", repository: "relative/path", shim: "/bin/omi" }],
    [{ distribution: "Ubuntu", repository: "/home/x", shim: "omi" }],
    [{ distribution: "Ubuntu", repository: "/home/x\n/y", shim: "/bin/omi" }],
    [{ distribution: "--exec", repository: "/home/x", shim: "/bin/omi" }],
    [{ distribution: "Ubuntu 24", repository: "/home/x", shim: "/bin/omi" }],
    [{ distribution: "Ubuntu", repository: "/home/x", shim: "/bin/omi", extra: 1 }],
    [{ distribution: "Ubuntu", repository: "/home/x" }],
  ])("refuses the config %j", (raw) => {
    expect(() => parseConfig(raw)).toThrow(BridgeInputError);
  });

  it("accepts a valid config and a check name that starts with a dash", () => {
    expect(parseConfig(config)).toEqual(config);
    expect(
      parseRequest({
        command: "deliver",
        runId: "run-1",
        prNumber: 1,
        reviewedHeadSha: SHA,
        requiredChecks: ["-weird name"],
      }),
    ).toMatchObject({ requiredChecks: ["-weird name"] });
  });
});

describe("the CLI's JSON answer is read strictly", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const doc = (body: Record<string, unknown>) =>
    bytes(`${JSON.stringify({ schemaVersion: 1, ...body })}\n`);

  it("returns the result of a successful command", () => {
    expect(
      parseCliOutput(doc({ ok: true, exitCode: 0, result: { runId: "r" } }), bytes(""), 0),
    ).toEqual({ ok: true, result: { runId: "r" } });
  });

  it.each([
    [1, "failure"],
    [2, "usage"],
    [3, "runtime-unavailable"],
    [4, "refused"],
    [5, "protocol"],
  ] as const)("classifies exit code %i as %s", (exitCode, kind) => {
    expect(
      parseCliOutput(
        doc({ ok: false, exitCode, error: { code: "COMMAND_REFUSED", message: "STEP_NOT_READY" } }),
        bytes(""),
        exitCode,
      ),
    ).toEqual({
      ok: false,
      kind,
      exitCode,
      code: "COMMAND_REFUSED",
      message: "STEP_NOT_READY",
    });
  });

  it.each([
    ["a document that disagrees with the exit code", doc({ ok: true, exitCode: 0, result: {} }), 4],
    ["success with a non-zero exit", doc({ ok: true, exitCode: 4, result: {} }), 4],
    [
      "an unsupported schema version",
      bytes('{"schemaVersion":2,"ok":true,"exitCode":0,"result":{}}'),
      0,
    ],
    ["a success without a result", doc({ ok: true, exitCode: 0 }), 0],
    ["a failure without an error", doc({ ok: false, exitCode: 4 }), 4],
    ["a JSON array", bytes("[]"), 0],
  ])("reports a protocol error for %s", (_name, stdout, exitCode) => {
    expect(parseCliOutput(stdout, bytes(""), exitCode)).toMatchObject({
      ok: false,
      kind: "protocol",
    });
  });

  it("never reads wsl.exe's own message as success and decodes its UTF-16 text", () => {
    const utf16 = Buffer.from("There is no distribution with the supplied name.\r\n", "utf16le");
    const outcome = parseCliOutput(utf16, new Uint8Array(), 4294967295);
    expect(outcome).toMatchObject({ ok: false, kind: "transport", code: "TRANSPORT_ERROR" });
    expect(outcome.ok ? "" : outcome.message).toContain("no distribution");
  });

  it("treats empty output with exit 0 as a transport failure", () => {
    expect(parseCliOutput(new Uint8Array(), new Uint8Array(), 0)).toMatchObject({
      ok: false,
      kind: "transport",
    });
  });

  it("strips control characters from a peer-supplied message", () => {
    const outcome = parseCliOutput(
      doc({
        ok: false,
        exitCode: 4,
        error: { code: "COMMAND_REFUSED", message: "a\u001b[31mb\n" },
      }),
      bytes(""),
      4,
    );
    const message = outcome.ok ? "" : outcome.message;
    expect(
      Array.from(message, (char) => char.codePointAt(0) ?? 0).every((code) => code >= 32),
    ).toBe(true);
  });
});

describe("callCli transport behaviour", () => {
  it("passes the pause reason on stdin to the shim", async () => {
    const wsl = createFakeWsl(() =>
      Promise.resolve({
        stdout: `${JSON.stringify({ schemaVersion: 1, ok: true, exitCode: 0, result: { ok: 1 } })}\n`,
        exitCode: 0,
      }),
    );
    const outcome = await callCli(
      config,
      { command: "pause", runId: "run-1", reason: 'multi\nline "text"' },
      { spawn: wsl.spawn, platform: "win32" },
    );
    expect(outcome).toEqual({ ok: true, result: { ok: 1 } });
    expect(wsl.calls[0]?.stdin).toBe('multi\nline "text"');
    expect(wsl.calls[0]?.cliArgs).toEqual(["--json", "pause", "--run=run-1", "--reason-stdin"]);
  });

  it("reports a spawn failure as a transport error without throwing", async () => {
    const outcome = await callCli(
      config,
      { command: "status" },
      {
        spawn: () => {
          throw new Error("ENOENT");
        },
      },
    ).catch((error: unknown) => error);
    // A synchronous spawn failure is still surfaced to the caller, never read as a result.
    expect(outcome).toBeInstanceOf(Error);
  });
});
