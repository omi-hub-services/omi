import { describe, expect, it } from "vitest";
import {
  runCli,
  type CliEnvironment,
} from "../../../../src/interfaces/cli/commands/create-program.ts";
import type { StatusReport } from "../../../../src/application/use-cases/project/report-status.ts";

const report: StatusReport = {
  schemaVersion: 1,
  generatedAt: "2026-11-12T10:00:00Z",
  statuses: [
    {
      status: "Ready",
      tasks: [{ number: 164, title: "Status", planKey: "OMI-081", priority: "P1" }],
    },
  ],
  ready: [],
  next: { number: 164, title: "Status", planKey: "OMI-081", priority: "P1" },
  pulls: [],
  workers: [],
  quota: null,
};
function setup() {
  let out = "";
  let err = "";
  const projects: string[] = [];
  const watches: unknown[] = [];
  const environment = {
    sendCommand: () => Promise.reject(new Error("IPC should not be needed")),
    defaultSocketPath: "/x",
    timeoutMs: 100,
    version: "0",
    stdout: (text: string) => {
      out += text;
    },
    stderr: (text: string) => {
      err += text;
    },
    overview: {
      status: (projectDir: string) => {
        projects.push(projectDir);
        return Promise.resolve(report);
      },
      watch: (input: {
        projectDir: string;
        port: number;
        intervalMs: number;
        onListening: (url: string) => void;
      }) => {
        watches.push({
          projectDir: input.projectDir,
          port: input.port,
          intervalMs: input.intervalMs,
        });
        input.onListening("http://127.0.0.1:4381");
        return Promise.resolve();
      },
    },
  } satisfies CliEnvironment;
  return {
    run: (args: string[]) => runCli(args, environment),
    output: () => ({ out, err }),
    projects,
    watches,
  };
}
describe("framework overview commands", () => {
  it("prints status text from the read-only report without IPC", async () => {
    const s = setup();
    expect(await s.run(["status", "--project", "/p"])).toBe(0);
    expect(s.projects).toEqual(["/p"]);
    expect(s.output().out).toContain("Ready: 1");
    expect(s.output().out).toContain("next: #164 OMI-081 Status");
    expect(s.output().out).toContain("quota: not configured");
  });
  it("prints the status report as JSON", async () => {
    const s = setup();
    expect(await s.run(["status", "--json"])).toBe(0);
    expect(JSON.parse(s.output().out)).toEqual({
      schemaVersion: 1,
      exitCode: 0,
      ok: true,
      result: report,
    });
  });
  it("starts watch with validated defaults and prints its local URL", async () => {
    const s = setup();
    expect(await s.run(["watch", "--project", "/p"])).toBe(0);
    expect(s.watches).toEqual([{ projectDir: "/p", port: 4381, intervalMs: 5000 }]);
    expect(s.output().out).toContain("http://127.0.0.1:4381");
  });
  it.each([
    ["--port", "-1"],
    ["--port", "65536"],
    ["--interval", "0"],
    ["--interval", "NaN"],
  ])("refuses watch %s %s", async (flag, value) => {
    const s = setup();
    expect(await s.run(["watch", flag, value])).toBe(2);
    expect(s.watches).toEqual([]);
  });
});
