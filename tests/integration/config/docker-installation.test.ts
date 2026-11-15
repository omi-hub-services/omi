import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { runCli } from "../../../src/interfaces/cli/commands/create-program.js";
import { installProjectTool } from "../../../src/application/use-cases/project/install-project-tool.js";
import { createProjectInstallation } from "../../../src/infrastructure/config/install-project-package.js";

// Map a Windows host's filesystem boundary onto a disposable Linux directory.
const host = vi.hoisted(() => ({ directory: "" }));
function native(path: string) {
  return path === "E:\\projects\\minibox" ? host.directory : path;
}
vi.mock("node:path", async (original) => {
  const path = await original<typeof import("node:path")>();
  const map = (value: string) => (value === "E:\\projects\\minibox" ? host.directory : value);
  return {
    ...path,
    join: (...parts: string[]) => path.join(...parts.map(map)),
    resolve: (...parts: string[]) => path.resolve(...parts.map(map)),
    relative: (from: string, to: string) => path.relative(map(from), map(to)),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, realpath: (path: string) => fs.realpath(native(path)) };
});

it("updates a Docker project on a Windows host path without a distribution and writes its Docker binding", async () => {
  const temp = await mkdtemp(join(tmpdir(), "omi-docker-install-"));
  host.directory = join(temp, "minibox");
  const root = resolve(".");
  const store = createProjectInstallation({
    sourceRoot: root,
    provision: async (source, tool) => {
      await mkdir(join(tool, "node_modules"), { recursive: true });
      await symlink(source, join(tool, "node_modules/omi-squad"));
    },
  });
  try {
    await mkdir(join(host.directory, ".omi"), { recursive: true });
    await installProjectTool(store, {
      projectDir: host.directory,
      packageDir: root,
      distribution: "Ubuntu",
      apply: true,
    });
    const lockPath = join(host.directory, ".omi/framework.lock.json");
    const previous = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    // A Windows clone can carry the old WSL checkout's binding.
    await writeFile(lockPath, JSON.stringify({ ...previous, projectDir: "/home/user/minibox" }));
    await writeFile(
      join(host.directory, ".omi/omisetting.local.json"),
      JSON.stringify({
        version: 1,
        github: { token: "fake-test-token", gitUser: { name: "bot", email: "bot@example.com" } },
        profiles: [{ id: "codex", tool: "codex", auth: { type: "login" } }],
        docker: { container: "omi-minibox" },
      }),
    );
    for (const verb of ["update", "install"]) {
      let output = "";
      const code = await runCli(
        [verb, "--project", "E:\\projects\\minibox", "--package", root, "--apply", "--json"],
        {
          version: "1",
          defaultSocketPath: "/unused",
          timeoutMs: 100,
          stdout: (text) => {
            output += text;
          },
          stderr: () => undefined,
          sendCommand: () => Promise.reject(new Error("unexpected IPC")),
          installation: {
            install: (input) => installProjectTool(store, input),
            doctor: () => Promise.reject(new Error("unexpected doctor")),
          },
        },
      );
      expect(code, output).toBe(0);
      const lock = JSON.parse(
        await readFile(join(host.directory, ".omi/framework.lock.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(lock.docker).toEqual({ container: "omi-minibox" });
      expect(lock.distribution).toBeUndefined();
      const bridge = JSON.parse(
        await readFile(join(host.directory, ".claude/skills/omi-squad/bridge.config.json"), "utf8"),
      ) as unknown;
      expect(bridge).toMatchObject({
        docker: { container: "omi-minibox" },
        repository: "/work/minibox",
        shim: "/work/minibox/.omi/bin/omi",
      });
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

it("requires a distribution for a project without Docker settings", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "omi-wsl-install-"));
  try {
    const store = createProjectInstallation({ sourceRoot: resolve(".") });
    await expect(
      installProjectTool(store, { projectDir, packageDir: resolve(".") }),
    ).rejects.toThrow(/distribution/i);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

it("refuses malformed settings before installation writes", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "omi-invalid-install-"));
  try {
    await mkdir(join(projectDir, ".omi"));
    await writeFile(join(projectDir, ".omi/omisetting.local.json"), "invalid");
    const store = createProjectInstallation({ sourceRoot: resolve(".") });
    await expect(
      installProjectTool(store, { projectDir, packageDir: resolve("."), distribution: "Ubuntu" }),
    ).rejects.toThrow("invalid JSON");
    await expect(readFile(join(projectDir, ".omi/framework.lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
