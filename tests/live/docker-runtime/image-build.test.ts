import { expect, it } from "vitest";
import {
  createDockerLifecycle,
  runDockerCommand,
} from "../../../src/infrastructure/processes/docker-runtime.js";
import { createDockerFixture, dockerContext, liveDocker, liveImage } from "./docker-fixture.ts";

it.skipIf(!liveDocker)(
  "AC-1 builds the pinned image and installs native dependencies",
  async () => {
    const context = dockerContext();
    const lifecycle = createDockerLifecycle({
      version: "0.1.1",
      run: (command) =>
        runDockerCommand(
          command.file === "docker"
            ? { ...command, args: ["--context", context, ...command.args] }
            : command,
        ),
      settings: () =>
        Promise.resolve({
          version: 1,
          github: { token: "fake", gitUser: { name: "live", email: "live@example.com" } },
          profiles: [{ id: "test", tool: "codex", auth: { type: "login" } }],
          docker: { image: liveImage, container: "omi-live-build" },
        }),
    });
    await lifecycle("build", { projectDir: process.cwd() });
    const fixture = await createDockerFixture();
    try {
      expect(
        (
          await fixture.docker([
            "ps",
            "-a",
            "--filter",
            "name=buildx_buildkit_omi-live-build-builder",
            "--format",
            "{{.Names}}",
          ])
        ).trim(),
      ).toBe("");
      expect(
        (
          await fixture.docker([
            "volume",
            "ls",
            "--filter",
            "name=buildx_buildkit_omi-live-build-builder",
            "--format",
            "{{.Name}}",
          ])
        ).trim(),
      ).toBe("");
      const output = await fixture.docker([
        "exec",
        "-w",
        "/work/framework",
        fixture.target.container,
        "node",
        "--input-type=module",
        "-e",
        "import Database from 'better-sqlite3'; const db = new Database(':memory:'); console.log(db.prepare('select 1 as value').get().value); db.close();",
      ]);
      expect(output.trim()).toBe("1");
    } finally {
      await fixture.stop();
    }
  },
  1_200_000,
);
