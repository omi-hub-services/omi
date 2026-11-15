import { lstat, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ProjectDirectoryMigration } from "../../application/ports/project-directory-migration.js";
import { assertPlainParents, readOptional } from "./package-content.js";
import { mergeProjectInstruction, projectInstructionBlock } from "./project-bridge.js";
import { runCommand } from "../processes/run-command.js";

// Kept only for explicit migration and refusal; ordinary readers use the current directory.
export const legacyProjectDirectory = ".omi-squad";
export const directoryMigrationHint = "LEGACY_INSTALLATION: run omi migrate-dir --project <path>";

export async function installationPathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    },
  );
}

export const migrateProjectDirectory: ProjectDirectoryMigration = async (projectDir) => {
  const root = await realpath(projectDir);
  if (root !== resolve(projectDir)) throw new Error("INVALID_INSTALLATION_TARGET");
  const directory = join(root, ".omi");
  if (await installationPathExists(directory)) throw new Error("INSTALL_DIRECTORY_EXISTS");
  const previous = join(root, legacyProjectDirectory);
  await assertPlainParents(root, previous);
  if (!(await lstat(previous)).isDirectory()) throw new Error("INVALID_INSTALLATION_TARGET");

  const writes: { path: string; before: string; after: string }[] = [];
  async function collect(path: string, instruction = false): Promise<void> {
    await assertPlainParents(root, path);
    const before = await readOptional(path);
    if (before === undefined) return;
    const text = instruction ? projectInstructionBlock(before) : before;
    if (text === undefined) return;
    const replaced = text.replaceAll(legacyProjectDirectory, ".omi");
    const after = instruction ? mergeProjectInstruction(before, replaced) : replaced;
    if (before !== after) writes.push({ path, before, after });
  }
  async function walk(path: string): Promise<void> {
    await assertPlainParents(root, path);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await walk(target);
      else await collect(target);
    }
  }
  // Runtime state and installed package bytes are preserved; update installs the new runtime.
  for (const name of ["config", "workflows", "roles", "rules", "skills", "provenance", "bin"]) {
    const path = join(previous, name);
    if (await installationPathExists(path)) await walk(path);
  }
  for (const name of ["framework.lock.json", "tool/package.json", "tool/package-lock.json"])
    await collect(join(previous, name));
  for (const name of ["CLAUDE.md", "AGENTS.md"]) await collect(join(root, name), true);
  await collect(join(root, ".gitignore"));
  for (const name of ["omi-squad", "omi-status", "omi-next", "omi-watch"]) {
    const path = join(root, ".claude/skills", name);
    if (await installationPathExists(path)) await walk(path);
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined),
  );
  async function move(from: string, to: string): Promise<void> {
    const result = await runCommand({
      executable: "git",
      args: ["mv", "--", from, to],
      cwd: root,
      env,
      timeoutMs: 30_000,
    });
    if (result.kind !== "finished" || result.exit.exitCode !== 0)
      throw new Error("DIRECTORY_MIGRATION_GIT_MOVE_FAILED");
  }
  await move(legacyProjectDirectory, ".omi");
  const movedPath = (path: string) =>
    path.startsWith(`${previous}${sep}`) ? directory + path.slice(previous.length) : path;
  try {
    for (const write of writes) await writeFile(movedPath(write.path), write.after);
  } catch (error) {
    for (const write of writes) await writeFile(movedPath(write.path), write.before);
    await move(".omi", legacyProjectDirectory);
    throw error;
  }
  return { directory };
};
