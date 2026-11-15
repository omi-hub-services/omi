import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../../src/interfaces/cli/commands/create-program.ts";
import type { CliEnvironment } from "../../../src/interfaces/cli/commands/create-program.ts";
function environment() {
  const launchSession = vi.fn(() => Promise.resolve({ exitCode: 0, runtimeStopped: true }));
  const stdout = vi.fn();
  const stderr = vi.fn();
  const sendCommand = vi.fn();
  const env: CliEnvironment = {
    launchSession,
    stdout,
    stderr,
    sendCommand,
    version: "0.0.0",
    timeoutMs: 1000,
    defaultSocketPath: "/unused",
  };
  return { env, launchSession, stdout, stderr, sendCommand };
}
describe("session CLI", () => {
  it("wires validated start input to the launcher, emits one JSON result and uses no IPC", async () => {
    const { env, launchSession, stdout, sendCommand } = environment();
    expect(
      await runCli(
        ["--json", "session", "start", "--project", "/project", "--runtime", "/tool/runtime.js"],
        env,
      ),
    ).toBe(0);
    expect(launchSession).toHaveBeenCalledWith({
      projectDir: "/project",
      runtimePath: "/tool/runtime.js",
      coordinator: "claude",
    });
    expect(stdout).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({ ok: true, exitCode: 0 });
    expect(sendCommand).not.toHaveBeenCalled();
  });
  it("reports unconfirmed teardown as failure", async () => {
    const { env, launchSession } = environment();
    launchSession.mockResolvedValue({ exitCode: 0, runtimeStopped: false });
    expect(await runCli(["session", "start", "--project", "/p", "--runtime", "/r.js"], env)).toBe(
      1,
    );
  });
  it("explains a runtime start failure with a fix instead of a generic internal error", async () => {
    const { env, launchSession, stderr } = environment();
    launchSession.mockRejectedValue(new Error("RUNTIME_START_FAILED"));
    expect(await runCli(["session", "start", "--project", "/p", "--runtime", "/r.js"], env)).toBe(
      1,
    );
    const output = String(stderr.mock.calls[0]?.[0] ?? "");
    expect(output).not.toContain("INTERNAL_ERROR");
    expect(output).toContain("RUNTIME_START_FAILED");
    expect(output).toContain("omi doctor");
  });
  it("refuses invalid paths before launching", async () => {
    const { env, launchSession } = environment();
    expect(
      await runCli(["session", "start", "--project", "relative", "--runtime", "/r.js"], env),
    ).toBe(2);
    expect(launchSession).not.toHaveBeenCalled();
  });
});
