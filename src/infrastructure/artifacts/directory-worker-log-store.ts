import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { ArtifactError } from "../../application/ports/artifact-store.js";
import type { WorkerLogStore } from "../../application/ports/worker-log-store.js";
import type { ArchivedLog, WorkerLog } from "../../domain/runs/log-retention-policy.js";

export interface DirectoryWorkerLogStoreOptions {
  readonly directory: string;
  /** Names of root files a live worker still writes. Default: none (recency still protects them). */
  readonly running?: () => ReadonlySet<string>;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** `<taskId>--<rest>`; a stream log is `<taskId>--<profile>--<timestamp>.jsonl`. */
const LOG_NAME = /^(?<task>[A-Za-z0-9][A-Za-z0-9._-]*?)--(?<rest>.+)$/;
const STREAM_LOG = /^(?<profile>[a-z0-9][a-z0-9._-]*)--[0-9T]+\.jsonl$/;

const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

function safeName(name: string): string {
  if (!SAFE_NAME.test(name) || name.includes("..")) throw new ArtifactError("INVALID_PATH");
  return name;
}

/** Worker logs as plain files: `<directory>/<name>` and `<directory>/archive/<name>.gz`. */
export function createDirectoryWorkerLogStore(
  options: DirectoryWorkerLogStoreOptions,
): WorkerLogStore {
  const archiveDir = join(options.directory, "archive");

  async function entries(
    directory: string,
  ): Promise<{ name: string; size: number; mtimeMs: number }[]> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const found: { name: string; size: number; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!SAFE_NAME.test(name)) continue;
      try {
        const info = await stat(join(directory, name));
        if (info.isFile()) found.push({ name, size: info.size, mtimeMs: info.mtimeMs });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return found;
  }

  return {
    async list() {
      const running = options.running?.() ?? new Set<string>();
      const root: WorkerLog[] = [];
      for (const file of await entries(options.directory)) {
        const task = LOG_NAME.exec(file.name)?.groups?.["task"];
        if (task === undefined) continue;
        const profile = STREAM_LOG.exec(file.name.slice(task.length + 2))?.groups?.["profile"];
        root.push({
          ...file,
          taskId: task,
          profile: profile ?? null,
          running: running.has(file.name),
        });
      }
      const archive: ArchivedLog[] = await entries(archiveDir);
      return { root, archive };
    },

    async archive(name) {
      const source = join(options.directory, safeName(name));
      let info;
      try {
        info = await stat(source);
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      await mkdir(archiveDir, { recursive: true });
      const target = join(archiveDir, `${name}.gz`);
      const partial = `${target}.partial`;
      await pipeline(createReadStream(source), createGzip(), createWriteStream(partial));
      // Keep the log's own age, so the archive cap measures the log and not the move.
      await utimes(partial, info.atime, info.mtime);
      await rename(partial, target);
      await rm(source, { force: true });
    },

    async remove(name) {
      const [first, second, ...extra] = name.split("/");
      const path =
        second === undefined
          ? join(options.directory, safeName(first ?? ""))
          : first === "archive" && extra.length === 0
            ? join(archiveDir, safeName(second))
            : undefined;
      if (path === undefined) throw new ArtifactError("INVALID_PATH");
      await rm(path, { force: true });
    },
  };
}
