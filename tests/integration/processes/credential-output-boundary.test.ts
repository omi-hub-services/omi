import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { startSupervisedProcess } from "../../../src/infrastructure/processes/supervised-process.ts";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

it.each(["stdout", "stderr", "json"] as const)(
  "refuses a configured credential split across %s chunks before exposing output",
  async (channel) => {
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 2147483647 });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = new PassThrough();
    vi.mocked(spawn).mockReturnValue(child);
    const lines: string[] = [];
    const started = startSupervisedProcess({
      executable: "fake-worker",
      args: [],
      cwd: "/tmp",
      env: {},
      stdin: "",
      onStdoutLine: (line) => {
        lines.push(line);
      },
      timeoutMs: 1000,
      graceMs: 10,
      maxStdoutChars: 1000,
      maxLineChars: 1000,
      maxStderrChars: 1000,
      credentialPolicy: { sensitiveValues: ["FAKE_CONFIGURED_VALUE"] },
    });
    child.emit("spawn");
    const worker = await started;
    const stream = channel === "stderr" ? stderr : stdout;
    if (channel === "json") {
      stream.write('{"text":"\\u0046AKE_CONFIG');
      stream.write('URED_VALUE"}\n');
    } else {
      stream.write("FAKE_CONFIG");
      stream.write("URED_VALUE\n");
    }
    child.emit("close", 0, null);
    const exit = await worker.exit;
    expect(lines).toEqual([]);
    expect(exit.stderr).not.toContain("FAKE_CONFIGURED_VALUE");
    expect(exit.exitCode).toBe(1);
  },
);

it("allows ordinary source text about native auth without exposing a configured value", async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 2147483647 });
  const stdout = new PassThrough();
  child.stdout = stdout;
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  vi.mocked(spawn).mockReturnValue(child);
  const lines: string[] = [];
  const started = startSupervisedProcess({
    executable: "fake-worker",
    args: [],
    cwd: "/tmp",
    env: {},
    stdin: "",
    onStdoutLine: (line) => {
      lines.push(line);
    },
    timeoutMs: 1000,
    graceMs: 10,
    maxStdoutChars: 1000,
    maxLineChars: 1000,
    maxStderrChars: 1000,
    credentialPolicy: { sensitiveValues: ["FAKE_CONFIGURED_VALUE"] },
  });
  child.emit("spawn");
  const worker = await started;
  stdout.write("Source test refers to auth.json\n");
  child.emit("close", 0, null);
  expect((await worker.exit).exitCode).toBe(0);
  expect(lines).toEqual(["Source test refers to auth.json"]);
});

it("refuses a token spanning stderr's diagnostic size limit", async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 2147483647 });
  const stderr = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = stderr;
  child.stdin = new PassThrough();
  vi.mocked(spawn).mockReturnValue(child);
  const started = startSupervisedProcess({
    executable: "fake-worker",
    args: [],
    cwd: "/tmp",
    env: {},
    stdin: "",
    onStdoutLine: () => {},
    timeoutMs: 1000,
    graceMs: 10,
    maxStdoutChars: 1000,
    maxLineChars: 1000,
    maxStderrChars: 12,
    credentialPolicy: { sensitiveValues: ["FAKE_CONFIGURED_VALUE"] },
  });
  child.emit("spawn");
  const worker = await started;
  stderr.write("noise FAKE_CONFIG");
  stderr.write("URED_VALUE");
  child.emit("close", 0, null);
  const exit = await worker.exit;
  expect(exit.exitCode).toBe(1);
  expect(exit.stderr).not.toContain("FAKE_");
});
