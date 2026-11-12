import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { templateFilesSchema } from "../../application/contracts/project-installation.js";
import { assertCredentialFree } from "../../application/contracts/credential-input.js";
import { wrapProjectInstruction } from "./project-bridge.js";

export const packageMetadataSchema = z.object({
  name: z.literal("omi-squad"),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
});
export async function readOptional(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      throw new Error("INVALID_INSTALLATION_FILE");
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** No symlinks in package assets or target managed paths. */
export async function assertPlainParents(root: string, path: string): Promise<void> {
  let current = root;
  for (const part of relative(root, path).split("/")) {
    if (part === "..") throw new Error("INVALID_INSTALLATION_PATH");
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("SYMLINK_INSTALLATION_PATH");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}
export async function readPackageContent(directory: string) {
  const root = await realpath(directory);
  const metadata = packageMetadataSchema.parse(
    JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown,
  );
  const digest = createHash("sha256");
  const templates: Record<string, string> = {};
  async function walk(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("SYMLINK_PACKAGE_CONTENT");
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name));
    } else if (info.isFile()) {
      const name = relative(root, path);
      const content = await readFile(path);
      digest.update(JSON.stringify([name, content.length])).update(content);
      if (name.startsWith("templates/project/") && !name.endsWith("/.gitkeep")) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        assertCredentialFree(text);
        const target = name.slice("templates/project/".length).replace(/^\.omi-squad\//, "");
        if (templates[target] !== undefined) throw new Error("DUPLICATE_TEMPLATE_TARGET");
        templates[target] = text;
      }
      if (name === "templates/bridges/CLAUDE.md" || name === "templates/bridges/AGENTS.md") {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        assertCredentialFree(text);
        templates[`bridge/${name.slice("templates/bridges/".length)}`] =
          wrapProjectInstruction(text);
      }
      if (/^templates\/bridges\/claude-code\/omi-(?:status|next|watch)\/SKILL\.md$/.test(name)) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        assertCredentialFree(text);
        templates[`bridge/skills/${name.slice("templates/bridges/claude-code/".length)}`] = text;
      }
      if (
        name === "templates/bridges/claude-code/omi-squad/SKILL.md" ||
        name === "templates/bridges/claude-code/omi-squad/bridge.ts"
      ) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        assertCredentialFree(text);
        templates[`bridge/skill/${name.slice("templates/bridges/claude-code/omi-squad/".length)}`] =
          text;
      }
    } else throw new Error("INVALID_PACKAGE_CONTENT");
  }
  await walk(join(root, "package.json"));
  for (const name of ["dist", "templates", "schemas", "migrations"]) await walk(join(root, name));
  return {
    version: metadata.version,
    artifactHash: digest.digest("hex"),
    base: templateFilesSchema.parse(templates),
  };
}
