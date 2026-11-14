import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ARCHIVE_FILE = /^([0-9a-f]{64})\.yaml$/;
const WORKFLOW_PATH = /^workflows\/[^/]+\.yaml$/;
const backupTemplatesSchema = z.record(z.string(), z.string());

function archiveDir(localDir: string): string {
  return join(localDir, "workflow-archive");
}

/** Stores a template under the sha-256 of its bytes; the same bytes are never rewritten. */
export async function archiveWorkflowTemplate(localDir: string, text: string): Promise<void> {
  const directory = archiveDir(localDir);
  const target = join(directory, `${sha256(text)}.yaml`);
  const stored = await readFile(target, "utf8").then(
    (existing) => existing,
    () => undefined,
  );
  if (stored === text) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, `.archive-${randomUUID()}`);
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, target);
}

async function readDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** Templates an installer replaced: `templates.json` of each install backup, workflow paths only. */
async function backedUpTemplates(localDir: string): Promise<string[]> {
  const texts: string[] = [];
  const root = join(localDir, "backups");
  for (const name of await readDirectory(root)) {
    if (!name.startsWith("install-")) continue;
    try {
      const parsed = backupTemplatesSchema.parse(
        JSON.parse(await readFile(join(root, name, "templates.json"), "utf8")) as unknown,
      );
      for (const [path, text] of Object.entries(parsed))
        if (WORKFLOW_PATH.test(path)) texts.push(text);
    } catch {
      // An unreadable or foreign backup holds no template we can trust; skip it.
    }
  }
  return texts;
}

/**
 * Every archived template plus those found in install backups (a run planned before the archive
 * existed). An archive file is used only when its bytes hash to its name. With `persist`, backup
 * templates are copied into the archive so they survive the backups being pruned.
 */
export async function readWorkflowArchive(localDir: string, persist: boolean): Promise<string[]> {
  const byHash = new Map<string, string>();
  const directory = archiveDir(localDir);
  for (const name of await readDirectory(directory)) {
    const match = ARCHIVE_FILE.exec(name);
    if (match === null) continue;
    const text = await readFile(join(directory, name), "utf8");
    if (sha256(text) === match[1]) byHash.set(sha256(text), text);
  }
  for (const text of await backedUpTemplates(localDir)) {
    const hash = sha256(text);
    if (byHash.has(hash)) continue;
    byHash.set(hash, text);
    if (persist) await archiveWorkflowTemplate(localDir, text);
  }
  return [...byHash.values()];
}
