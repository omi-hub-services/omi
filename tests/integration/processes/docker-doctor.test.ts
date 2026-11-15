import { expect, it } from "vitest";
import {
  createInstallationDoctor,
  type WslProbe,
} from "../../../src/infrastructure/processes/installation-doctor.js";

it("reports Docker capacity and warns above configured limits without WSL probes", async () => {
  const calls: string[][] = [];
  const probe: WslProbe = {
    settings: () =>
      Promise.resolve({
        version: 1,
        github: { token: "fake", gitUser: { name: "bot", email: "bot@example.com" } },
        profiles: [{ id: "test", tool: "codex", auth: { type: "login" } }],
        docker: {},
      }),
    kernel: () => Promise.reject(new Error("WSL must not be probed")),
    distro: () => undefined,
    interop: () => Promise.resolve(false),
    canonical: (path) => Promise.resolve(path),
    projectConfig: () => Promise.resolve(undefined),
    command: (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === "version") return Promise.resolve("27.0.0");
      if (args[0] === "inspect") return Promise.resolve("true");
      if (args[0] === "volume") return Promise.resolve("omi-project-work");
      if (args[0] === "stats")
        return Promise.resolve('{"MemPerc":"81.2%","MemUsage":"6.5GiB / 8GiB"}');
      if (args.includes("du")) return Promise.resolve("21000000000\t/work");
      if (args.includes("claude")) return Promise.resolve("2.1.322 (Claude Code)");
      if (args.includes("codex"))
        return Promise.resolve(
          args.includes("--version") ? "codex-cli 0.167.0" : "Logged in using ChatGPT",
        );
      return Promise.resolve("");
    },
  };
  const report = await createInstallationDoctor(probe)({
    projectDir: "/home/user/project",
    distribution: "Ubuntu",
  });
  expect(report.checks.find((check) => check.name === "docker-memory")).toMatchObject({
    status: "warn",
  });
  expect(report.checks.find((check) => check.name === "docker-work-volume-size")).toMatchObject({
    status: "warn",
  });
  expect(report.checks.find((check) => check.name === "worker-cli-codex")).toMatchObject({
    ok: true,
  });
  expect(calls.some(([file]) => file === "wsl.exe")).toBe(false);
});
