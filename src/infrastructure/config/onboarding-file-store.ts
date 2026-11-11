import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { assertCredentialFree } from "../../application/contracts/credential-input.js";
import { relativePathSchema } from "../../application/contracts/identifiers.js";
import { ProjectInitializationError } from "../../application/ports/github-project-reader.js";
import type { OnboardingFileStore } from "../../application/ports/onboarding-file-store.js";

const MAX_FILE_BYTES = 1024 * 1024;
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

/**
 * Bootstrap supplies the target repository root. Files are only ever created: an existing
 * destination (even a symlink or a file created after a preview) wins, and a parent directory that
 * is a symlink is refused so a write cannot be redirected outside the root.
 */
export async function createOnboardingFileStore(directory: string): Promise<OnboardingFileStore> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new ProjectInitializationError("INVALID_REPOSITORY_ROOT");
  const root = await realpath(directory);

  const resolve = (path: string): string[] => {
    const parsed = relativePathSchema.safeParse(path);
    if (!parsed.success) throw new ProjectInitializationError("INVALID_ONBOARDING_PATH");
    return parsed.data.split("/").filter((part) => part.length > 0 && part !== ".");
  };

  /** Walks existing parents; returns false when one is missing, throws when one is not a plain dir. */
  const parentsExist = async (parts: readonly string[], create: boolean): Promise<boolean> => {
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new ProjectInitializationError("INVALID_ONBOARDING_PATH");
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        if (!create) return false;
        await mkdir(current);
      }
    }
    return true;
  };

  return {
    async exists(path) {
      const parts = resolve(path);
      if (!(await parentsExist(parts, false))) return false;
      try {
        await lstat(join(root, ...parts));
        return true;
      } catch (error) {
        if (hasCode(error, "ENOENT")) return false;
        throw error;
      }
    },
    async create(path, content) {
      const parts = resolve(path);
      assertCredentialFree(content);
      if (Buffer.byteLength(content) > MAX_FILE_BYTES)
        throw new ProjectInitializationError("ONBOARDING_FILE_TOO_LARGE");
      await parentsExist(parts, true);
      const destination = join(root, ...parts);
      const temp = join(dirname(destination), `.onboarding-${randomUUID()}.tmp`);
      const file = await open(temp, "wx", 0o600);
      try {
        try {
          await file.writeFile(content, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          // link() publishes the complete synced inode and refuses any existing destination.
          await link(temp, destination);
        } catch (error) {
          if (hasCode(error, "EEXIST")) return "exists";
          throw error;
        }
        return "created";
      } finally {
        await unlink(temp);
      }
    },
  };
}
