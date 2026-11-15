import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateProjectDirectory } from "../../../src/application/use-cases/project/migrate-project-directory.js";
import {
  legacyProjectDirectory,
  migrateProjectDirectory as migrateDirectory,
} from "../../../src/infrastructure/config/migrate-project-directory.js";
import { runCli } from "../../../src/interfaces/cli/commands/create-program.js";

const exec = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omi-directory-"));
  await exec("git", ["init", root]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function legacy() {
  const directory = join(root, legacyProjectDirectory);
  await mkdir(join(directory, "tool"), { recursive: true });
  await mkdir(join(directory, "local"));
  await mkdir(join(directory, "provenance"));
  const oldPath = `${legacyProjectDirectory}/bin/omi`;
  for (const path of [
    "framework.lock.json",
    "tool/package-lock.json",
    "provenance/skills.lock.json",
  ])
    await writeFile(join(directory, path), JSON.stringify({ path: oldPath, name: "omi-squad" }));
  await writeFile(join(directory, "local/state"), oldPath);
  await writeFile(join(root, ".gitignore"), `${legacyProjectDirectory}/local/\n`);
  const instructions = `user ${oldPath}\n<!-- omi-squad:start -->\n${oldPath}\n<!-- omi-squad:end -->\n`;
  await writeFile(join(root, "AGENTS.md"), instructions);
  await mkdir(join(root, ".claude/skills/omi-squad"), { recursive: true });
  await writeFile(
    join(root, ".claude/skills/omi-squad/bridge.config.json"),
    JSON.stringify({ shim: oldPath }),
  );
  await exec("git", ["-C", root, "add", "."]);
  return { directory, oldPath };
}
describe("directory migration", () => {
  it("moves tracked files through the CLI and rewrites lockfiles and managed bridges", async () => {
    const { oldPath } = await legacy();
    let output = "";
    const code = await runCli(["migrate-dir", "--project", root, "--json"], {
      defaultSocketPath: "/unused",
      timeoutMs: 100,
      version: "1",
      sendCommand: () => Promise.reject(new Error("unexpected IPC")),
      stdout: (text) => {
        output += text;
      },
      stderr: () => undefined,
      installation: {
        migrateDirectory: (input) => migrateProjectDirectory(migrateDirectory, input),
        install: () => Promise.reject(new Error("unexpected install")),
        doctor: () => Promise.reject(new Error("unexpected doctor")),
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      result: { directory: join(root, ".omi") },
    });
    expect(await readdir(root)).not.toContain(legacyProjectDirectory);
    for (const path of [
      "framework.lock.json",
      "tool/package-lock.json",
      "provenance/skills.lock.json",
    ])
      expect(JSON.parse(await readFile(join(root, ".omi", path), "utf8"))).toEqual({
        path: ".omi/bin/omi",
        name: "omi-squad",
      });
    expect(await readFile(join(root, ".omi/local/state"), "utf8")).toBe(oldPath);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(".omi/local/\n");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
      `user ${oldPath}\n<!-- omi-squad:start -->\n.omi/bin/omi\n<!-- omi-squad:end -->\n`,
    );
    expect(
      JSON.parse(await readFile(join(root, ".claude/skills/omi-squad/bridge.config.json"), "utf8")),
    ).toEqual({ shim: ".omi/bin/omi" });
    expect((await exec("git", ["-C", root, "ls-files", ".omi"])).stdout).toContain(
      ".omi/framework.lock.json",
    );
  });
  it("refuses an existing destination without changing either tree", async () => {
    const { directory } = await legacy();
    await mkdir(join(root, ".omi"));
    await expect(migrateProjectDirectory(migrateDirectory, { projectDir: root })).rejects.toThrow(
      "INSTALL_DIRECTORY_EXISTS",
    );
    expect(await readdir(directory)).toContain("framework.lock.json");
    expect(await readdir(join(root, ".omi"))).toEqual([]);
  });
  it("refuses symlinked managed files before moving anything", async () => {
    const { directory } = await legacy();
    await symlink(join(root, "AGENTS.md"), join(directory, "tool/package.json"));
    await expect(migrateDirectory(root)).rejects.toThrow("SYMLINK_INSTALLATION_PATH");
    expect(await readdir(root)).toContain(legacyProjectDirectory);
  });
  it("leaves an untracked installation intact when git mv refuses it", async () => {
    const { directory } = await legacy();
    await exec("git", ["-C", root, "rm", "--cached", "-r", legacyProjectDirectory]);
    await expect(migrateDirectory(root)).rejects.toThrow("DIRECTORY_MIGRATION_GIT_MOVE_FAILED");
    expect(await readdir(directory)).toContain("framework.lock.json");
  });
});
