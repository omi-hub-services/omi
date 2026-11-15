import fs from "node:fs";
import { join } from "node:path";
import { artifactPathSchema } from "../../application/contracts/artifact.js";
import { ArtifactError } from "../../application/ports/artifact-store.js";

export function validateArtifactPath(path: unknown): string {
  const parsed = artifactPathSchema.safeParse(path);
  if (!parsed.success) throw new ArtifactError("INVALID_PATH");
  return parsed.data;
}

export function hasFsCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Directory fsync is unsupported on some platforms/filesystems; other failures must propagate. */
export function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    if (
      !hasFsCode(error, "EINVAL") &&
      !hasFsCode(error, "ENOTSUP") &&
      !hasFsCode(error, "EOPNOTSUPP") &&
      !(process.platform === "win32" && hasFsCode(error, "EPERM"))
    ) {
      throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Reject all symlinks, even links pointing inward. The root is canonical and runtime-owned;
 * this is not a sandbox against a hostile same-user process swapping ancestors during I/O.
 */
export function resolveArtifactPath(root: string, path: string, createParents: boolean): string {
  try {
    if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) {
      throw new ArtifactError("INVALID_PATH");
    }
  } catch (error) {
    if (hasFsCode(error, "ENOENT")) throw new ArtifactError("NOT_FOUND");
    throw error;
  }
  const parts = validateArtifactPath(path).split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    const parent = current;
    current = join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (!hasFsCode(error, "ENOENT")) throw error;
      if (index === parts.length - 1) return current;
      if (!createParents) throw new ArtifactError("NOT_FOUND");
      fs.mkdirSync(current, { mode: 0o700 });
      syncDirectory(parent);
      stat = fs.lstatSync(current);
    }
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
    ) {
      throw new ArtifactError("INVALID_PATH");
    }
  }
  return current;
}
