import { expect, it, vi } from "vitest";

vi.mock("../../../src/infrastructure/processes/run-command.js", () => ({
  runCommand: (options: { args: readonly string[] }) =>
    Promise.resolve({
      kind: "finished",
      exit: {
        exitCode: 0,
        stderr: options.args.includes("status") ? "Logged in using ChatGPT" : "",
      },
      stdout: "",
    }),
}));

import {
  createInstallationDoctor,
  systemProbe,
  type WslProbe,
} from "../../../src/infrastructure/processes/installation-doctor.js";

it("accepts the Codex login status that the CLI prints on stderr", async () => {
  const probe: WslProbe = {
    ...systemProbe,
    settings: () =>
      Promise.resolve({
        version: 1,
        github: { token: "fake", gitUser: { name: "bot", email: "bot@example.com" } },
        profiles: [{ id: "codex-a", tool: "codex", auth: { type: "login" } }],
        docker: {},
      }),
    kernel: () => Promise.reject(new Error("WSL must not be probed")),
    interop: () => Promise.resolve(false),
    canonical: (path) => Promise.resolve(path),
    projectConfig: () => Promise.resolve(undefined),
  };
  const report = await createInstallationDoctor(probe)({
    projectDir: "/home/user/project",
    distribution: "Ubuntu",
  });
  expect(report.checks.find((check) => check.name === "profiles[0].auth")).toMatchObject({
    ok: true,
  });
});
