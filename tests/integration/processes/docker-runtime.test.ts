import { describe, expect, it } from "vitest";
import {
  createDockerLifecycle,
  type DockerCommand,
} from "../../../src/infrastructure/processes/docker-runtime.js";
import type { OmiSetting } from "../../../src/application/contracts/omisetting.js";

const settings: OmiSetting = {
  version: 1,
  github: { token: "fake-github-value", gitUser: { name: "bot", email: "bot@example.com" } },
  profiles: [{ id: "login", tool: "codex", auth: { type: "login" } }],
  docker: {},
};

it("creates token profile directories before the first runtime probe", async () => {
  const calls: DockerCommand[] = [];
  const lifecycle = createDockerLifecycle({
    version: "0.1.1",
    settings: () =>
      Promise.resolve({
        ...settings,
        profiles: [
          ...settings.profiles,
          { id: "claude-main", tool: "claude", auth: { type: "token", token: "fake-profile" } },
        ],
      }),
    run: (command) => {
      calls.push(command);
      return Promise.resolve({
        code: command.args[0] === "container" ? 1 : 0,
        stdout: command.file === "git" ? "https://github.com/acme/demo.git" : "",
      });
    },
  });
  await lifecycle("up", { projectDir: "/tmp/demo" });
  expect(
    calls.some(
      (command) =>
        command.args.join(" ") === "exec omi-demo mkdir -m 700 -p /work/.profiles/claude-main",
    ),
  ).toBe(true);
});

it("creates a bounded container with no persistent credentials and keeps volumes on down", async () => {
  const calls: DockerCommand[] = [];
  const lifecycle = createDockerLifecycle({
    version: "0.1.1",
    settings: () => Promise.resolve(settings),
    run: (command) => {
      calls.push(command);
      return Promise.resolve({
        code: command.args[0] === "container" ? 1 : 0,
        stdout: command.file === "git" ? "https://github.com/acme/demo.git" : "",
      });
    },
  });
  await lifecycle("up", { projectDir: "/tmp/demo" });
  const create = calls.find((command) => command.args[0] === "run");
  expect(create?.args).toContain("unless-stopped");
  expect(create?.args).toContain("8g");
  expect(create?.args).toContain("127.0.0.1:4381:4381");
  expect(create?.args).toContain("type=volume,src=omi-profile-login,dst=/profiles/login");
  expect(JSON.stringify(create)).not.toContain(settings.github.token);
  expect(create?.env).toBeUndefined();
  const clone = calls.find((command) => command.args.includes("/usr/local/lib/omi-init.mjs"));
  expect(clone?.args).toContain("GH_TOKEN");
  expect(clone?.args.join(" ")).not.toContain(settings.github.token);
  expect(clone?.input).not.toContain(settings.github.token);
  calls.length = 0;
  await lifecycle("down", { projectDir: "/tmp/demo" });
  expect(calls.some((command) => command.args[0] === "volume")).toBe(false);
});

it("prunes only its own builder after a successful build", async () => {
  const calls: DockerCommand[] = [];
  const lifecycle = createDockerLifecycle({
    version: "0.1.1",
    settings: () => Promise.resolve(settings),
    run: (command) => {
      calls.push(command);
      return Promise.resolve({
        code: 0,
        stdout:
          command.args[0] === "image" && command.args[1] === "ls"
            ? "omi-worker:0.1.0\nomi-worker:0.1.1"
            : "",
      });
    },
  });
  await lifecycle("build", { projectDir: "/tmp/demo" });
  expect(calls.some((command) => command.args.join(" ") === "image rm omi-worker:0.1.0")).toBe(
    true,
  );
  expect(calls.at(-1)?.args).toEqual([
    "buildx",
    "prune",
    "--builder",
    "omi-demo-builder",
    "--force",
  ]);
});

it("does not delete images after a failed build", async () => {
  const calls: DockerCommand[] = [];
  const lifecycle = createDockerLifecycle({
    version: "0.1.1",
    settings: () => Promise.resolve(settings),
    run: (command) => {
      calls.push(command);
      return Promise.resolve({ code: command.args[1] === "build" ? 1 : 0, stdout: "" });
    },
  });
  await expect(lifecycle("build", { projectDir: "/tmp/demo" })).rejects.toThrow(
    "DOCKER_COMMAND_FAILED",
  );
  expect(calls.some((command) => command.args[0] === "image")).toBe(false);
});

describe("Docker runtime boundary", () => {
  it("forwards only environment names in exec argv", async () => {
    const runtime = await import("../../../src/infrastructure/processes/docker-runtime.js").catch(
      () => undefined,
    );
    expect(runtime?.dockerExecCommand, "Docker exec boundary is missing").toBeTypeOf("function");
    const command = runtime?.dockerExecCommand(
      { container: "omi-demo", repoDir: "/work/demo" },
      "true",
      ["GH_TOKEN"],
    );
    expect(command?.args).toEqual([
      "exec",
      "-i",
      "-e",
      "GH_TOKEN",
      "-w",
      "/work/demo",
      "omi-demo",
      "bash",
      "-lc",
      "true",
    ]);
  });
});
