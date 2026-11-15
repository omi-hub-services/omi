import { describe, expect, it } from "vitest";
import { runCli } from "../../src/interfaces/cli/commands/create-program.js";
import { installProjectTool } from "../../src/application/use-cases/project/install-project-tool.js";
import type { FrameworkLock } from "../../src/application/contracts/project-installation.js";

async function cli(extra: string[] = [], conflict = false) {
  const lock: FrameworkLock = {
    schemaVersion: 1,
    projectDir: "/project",
    distribution: "Ubuntu",
    version: "0.1.0",
    artifactHash: "a".repeat(64),
    base: conflict ? { "rules/example.md": "old" } : {},
  };
  let output = "";
  let writes = 0;
  let cleanups = 0;
  const code = await runCli(
    ["update", "--project", "/project", "--distribution", "Ubuntu", ...extra],
    {
      sendCommand: () => Promise.reject(new Error("unexpected IPC")),
      defaultSocketPath: "/unused",
      timeoutMs: 100,
      version: "0.1.0",
      stdout: (text) => {
        output += text;
      },
      stderr: (text) => {
        output += text;
      },
      installation: {
        doctor: () => Promise.reject(new Error("unexpected doctor")),
        install: (input) =>
          installProjectTool(
            {
              inspect: () =>
                Promise.resolve({
                  installed: lock,
                  candidate: {
                    ...lock,
                    version: "0.2.0",
                    base: conflict ? { "rules/example.md": "incoming" } : {},
                  },
                  local: conflict ? { "rules/example.md": "local" } : {},
                }),
              apply: () => {
                writes++;
                return Promise.resolve({ backupDir: "/backup" });
              },
            },
            input,
            {
              prepare: () =>
                Promise.resolve({
                  packageDir: "/download/package",
                  changelog: "## [0.2.0] - 2026-11-13\n### Breaking\n- Rename setting\n",
                  cleanup: () => {
                    cleanups++;
                    return Promise.resolve();
                  },
                }),
            },
          ),
      },
    },
  );
  return { code, output, writes, cleanups };
}
describe("release update CLI", () => {
  it("shows breaking notes even when the preview has template conflicts", async () => {
    const result = await cli(["--version", "0.2.0"], true);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Template conflicts");
    expect(result.output).toContain("Rename setting");
    expect(result.writes).toBe(0);
  });
  it("prints breaking release notes in the default text preview", async () => {
    const result = await cli(["--version", "0.2.0"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("preview: 0.2.0");
    expect(result.output).toContain("### Breaking\n- Rename setting");
    expect(result.writes).toBe(0);
    expect(result.cleanups).toBe(1);
  });
  it("refuses breaking apply and explains explicit acceptance", async () => {
    const result = await cli(["--version", "0.2.0", "--apply"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("--accept-breaking");
    expect(result.writes).toBe(0);
  });
  it("accepts breaking apply and includes notes in JSON", async () => {
    const result = await cli(["--version", "0.2.0", "--apply", "--accept-breaking", "--json"]);
    expect(result.code).toBe(0);
    expect(result.writes).toBe(1);
    expect(result.output).toContain("Rename setting");
  });
  it("retains the offline package command", async () => {
    const result = await cli(["--package", "/offline", "--apply"]);
    expect(result.code).toBe(0);
    expect(result.writes).toBe(1);
    expect(result.cleanups).toBe(0);
  });
  it.each([{ args: [] }, { args: ["--version", "0.2.0", "--package", "/offline"] }])(
    "refuses absent or competing sources: %j",
    async ({ args }) => {
      const result = await cli(args);
      expect(result.code).not.toBe(0);
      expect(result.writes).toBe(0);
    },
  );
});
