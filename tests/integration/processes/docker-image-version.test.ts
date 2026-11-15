import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { OmiSetting } from "../../../src/application/contracts/omisetting.js";

vi.mock("../../../src/infrastructure/config/package-content.js", async (original) => ({
  ...(await original<object>()),
  readPackageVersion: () => "9.8.7",
}));
vi.mock("../../../src/infrastructure/config/load-omisetting.js", () => ({
  loadOmiSetting: () => Promise.resolve(settings),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<object>()),
  spawn: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  },
}));
import * as runtime from "../../../src/infrastructure/processes/docker-runtime.js";
import { readPackageVersion } from "../../../src/bootstrap/container.js";
import { createProfileLogin } from "../../../src/infrastructure/profiles/login-profile.js";
import { createInstallationDoctor } from "../../../src/infrastructure/processes/installation-doctor.js";
import { coordinatorTarget } from "../../../tools/coordinator/coordinator-target.ts";

const settings: OmiSetting = {
  version: 1,
  github: { token: "fake", gitUser: { name: "bot", email: "bot@example.com" } },
  profiles: [{ id: "login", tool: "codex", auth: { type: "login" } }],
  docker: {},
};

it.each([undefined, "omi-worker:custom"])(
  "shares the package image default and override %s across Docker callers",
  async (image) => {
    settings.docker = image === undefined ? {} : { image };
    const expected = image ?? "omi-worker:9.8.7";
    const projects = vi.spyOn(runtime, "dockerProject");
    try {
      expect(readPackageVersion()).toBe("9.8.7");
      expect(runtime.dockerProject(settings, "/tmp/demo").image).toBe(expected);
      const calls: runtime.DockerCommand[] = [];
      await runtime.createDockerLifecycle({
        settings: () => Promise.resolve(settings),
        run: (call) => {
          calls.push(call);
          return Promise.resolve({ code: 0, stdout: "" });
        },
      })("build", { projectDir: "/tmp/demo" });
      expect(calls.find((call) => call.args[1] === "build")?.args).toContain(expected);
      projects.mockClear();
      await coordinatorTarget("/tmp/demo");
      await createProfileLogin()({ projectDir: "/tmp/demo", profileId: "login" });
      await createInstallationDoctor({
        settings: () => Promise.resolve(settings),
        kernel: () => Promise.resolve(""),
        distro: () => undefined,
        interop: () => Promise.resolve(false),
        canonical: (path) => Promise.resolve(path),
        projectConfig: () => Promise.resolve(undefined),
        command: () => Promise.resolve(undefined),
      })({ projectDir: "/tmp/demo", distribution: "docker" });
      expect(
        projects.mock.results.map((result) => (result.value as { image: string }).image),
      ).toEqual([expected, expected, expected]);
    } finally {
      projects.mockRestore();
    }
  },
);
