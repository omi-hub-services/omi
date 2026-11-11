import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { assertCredentialFree } from "../../application/contracts/credential-input.js";
import { projectConfigSchema } from "../../application/contracts/project-config.js";
import { ProjectInitializationError } from "../../application/ports/github-project-reader.js";
import type { ProjectConfigStore } from "../../application/ports/project-config-store.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

/** Bootstrap supplies an existing target config directory. Init never installs into its source repo. */
export async function createProjectConfigStore(directory: string): Promise<ProjectConfigStore> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new ProjectInitializationError("INVALID_CONFIG_DIRECTORY");
  const root = await realpath(directory);
  const path = join(root, "project.yaml");
  return {
    async read() {
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw new ProjectInitializationError("CONFIG_UNREADABLE");
      }
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES)
          throw new ProjectInitializationError("INVALID_CONFIG_FILE");
        const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (chunk.bytesRead === 0) break;
          bytesRead += chunk.bytesRead;
        }
        if (bytesRead > MAX_CONFIG_BYTES) throw new ProjectInitializationError("CONFIG_TOO_LARGE");
        const document = parseDocument(
          new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)),
          { uniqueKeys: true, customTags: [], schema: "core" },
        );
        if (document.errors.length > 0 || document.warnings.length > 0)
          throw new ProjectInitializationError("INVALID_CONFIG_YAML");
        const value: unknown = document.toJS({ maxAliasCount: 0 });
        assertCredentialFree(value);
        return projectConfigSchema.parse(value);
      } finally {
        await file.close();
      }
    },
    async create(input) {
      const config = projectConfigSchema.parse(input);
      assertCredentialFree(config);
      const text = stringify(config);
      if (Buffer.byteLength(text) > MAX_CONFIG_BYTES)
        throw new ProjectInitializationError("CONFIG_TOO_LARGE");
      const temp = join(root, `.project-${randomUUID()}.tmp`);
      const file = await open(temp, "wx", 0o600);
      try {
        try {
          await file.writeFile(text, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          // link() publishes the complete synced inode and refuses any existing destination.
          await link(temp, path);
        } catch (error) {
          if (hasCode(error, "EEXIST")) return "exists";
          throw error;
        }
        const dir = await open(root, "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
        return "created";
      } finally {
        await unlink(temp);
      }
    },
  };
}
