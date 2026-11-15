import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ProjectInitializationError } from "../../application/ports/github-project-reader.js";
import type { CodebaseReader } from "../../application/ports/codebase-reader.js";
import { wslPathSchema } from "../../application/contracts/session-launch.js";

const MAX_MARKER_BYTES = 256 * 1024;

/** Bootstrap supplies the target repository root; only direct, regular, non-symlink files are seen. */
export async function createCodebaseReader(
  directory: string,
  sourceRoot?: string,
): Promise<CodebaseReader> {
  wslPathSchema.parse(directory);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new ProjectInitializationError("INVALID_REPOSITORY_ROOT");
  const root = await realpath(directory);
  if (sourceRoot !== undefined && root === (await realpath(sourceRoot)))
    throw new ProjectInitializationError("INVALID_REPOSITORY_ROOT");
  return {
    async rootFiles() {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    },
    async readText(name) {
      if (name.includes("/") || name.includes("\\") || name === "..") return undefined;
      let file;
      try {
        file = await open(
          join(root, name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch {
        return undefined;
      }
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > MAX_MARKER_BYTES) return undefined;
        return (await file.readFile()).toString("utf8");
      } catch {
        return undefined;
      } finally {
        await file.close();
      }
    },
  };
}
