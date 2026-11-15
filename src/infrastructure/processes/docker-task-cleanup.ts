import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startIdentity, groupGone } from "./worker-recovery.js";

const processReference = z.strictObject({
  pid: z.number().int().min(2),
  startIdentity: z.string().min(1),
});

/** A persisted pid is usable only while its boot id and kernel start ticks still match. */
export async function cleanupDockerTask(
  task: string,
  runsDir = join(homedir(), "omi-runs"),
): Promise<void> {
  if (!/^\d{1,6}$/.test(task)) throw new Error("Invalid cleanup task");
  const files = await readdir(runsDir).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of files.filter(
    (name) => name.startsWith(`omi-${task}-process-`) && /^[A-Za-z0-9._-]+\.json$/.test(name),
  )) {
    let reference: z.infer<typeof processReference>;
    try {
      reference = processReference.parse(
        JSON.parse(await readFile(join(runsDir, name), "utf8")) as unknown,
      );
    } catch {
      throw new Error("Invalid Docker worker ownership record");
    }
    const identity = startIdentity(reference.pid);
    if (
      (identity === undefined && !groupGone(reference.pid)) ||
      (identity !== undefined && identity !== reference.startIdentity)
    )
      throw new Error("Docker worker ownership changed; cleanup refused");
    if (identity !== undefined) {
      try {
        process.kill(-reference.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    await rm(join(runsDir, name));
  }
  for (const name of files.filter(
    (name) => name.startsWith(`omi-${task}-tmp-`) && /^[A-Za-z0-9._-]+$/.test(name),
  )) {
    await rm(join(runsDir, name), { recursive: true, force: true });
  }
}

if (import.meta.main) await cleanupDockerTask(process.argv[2] ?? "");
