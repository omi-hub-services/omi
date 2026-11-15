import { expect, it, vi } from "vitest";

vi.mock("node:path", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:path")>();
  return { ...original, join: (...parts: string[]) => original.win32.join(...parts) };
});
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => "C:\\Users\\someone" };
});

import {
  createInstallationDoctor,
  type WslProbe,
} from "../../../src/infrastructure/processes/installation-doctor.js";

it("builds container profile paths from the profile id when the host home is a Windows path", async () => {
  const execs: { args: string[]; env: Record<string, string> | undefined }[] = [];
  const probe: WslProbe = {
    settings: () =>
      Promise.resolve({
        version: 1,
        github: { token: "fake", gitUser: { name: "bot", email: "bot@example.com" } },
        profiles: [
          { id: "codex-win", tool: "codex", auth: { type: "login" } },
          { id: "claude-win", tool: "claude", auth: { type: "token", token: "fake-token" } },
        ],
        docker: {},
      }),
    kernel: () => Promise.reject(new Error("WSL must not be probed")),
    distro: () => undefined,
    interop: () => Promise.resolve(false),
    canonical: (path) => Promise.resolve(path),
    projectConfig: () => Promise.resolve(undefined),
    command: (file, args, _cwd, env) => {
      if (file === "docker" && args[0] === "exec") execs.push({ args: [...args], env });
      if (args.includes("codex")) return Promise.resolve("Logged in using ChatGPT");
      if (args.includes("claude")) return Promise.resolve('{"loggedIn":true}');
      return Promise.resolve("");
    },
  };
  await createInstallationDoctor(probe)({
    projectDir: "/home/user/project",
    distribution: "Ubuntu",
  });
  const codex = execs.find((call) => call.args.includes("login"));
  const claude = execs.find((call) => call.args.includes("auth"));
  expect(codex?.env?.["CODEX_HOME"]).toBe("/profiles/codex-win");
  expect(claude?.env?.["CLAUDE_CONFIG_DIR"]).toBe("/work/.profiles/claude-win");
});
