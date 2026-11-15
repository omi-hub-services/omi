import { describe, expect, it } from "vitest";
import { runCli } from "../../../../src/interfaces/cli/commands/create-program.js";

describe("Docker lifecycle CLI", () => {
  it("routes build to the injected Docker port", async () => {
    const actions: string[] = [];
    const code = await runCli(["docker", "build"], {
      version: "0.1.1",
      defaultSocketPath: "/tmp/unused",
      timeoutMs: 1000,
      stdout: () => undefined,
      stderr: () => undefined,
      sendCommand: () => Promise.reject(new Error("IPC must not be used")),
      docker: (action) => {
        actions.push(action);
        return Promise.resolve();
      },
    });
    expect(code).toBe(0);
    expect(actions).toEqual(["build"]);
  });
});
