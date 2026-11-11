import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { StateDatabase } from "./sqlite-connection.js";

/** Online backup includes committed WAL data; a raw copy of state.sqlite would not. */
export async function backupState(db: StateDatabase, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, "state.sqlite");
  await db.backup(destination);
  if (db.pragma("integrity_check", { simple: true }) !== "ok")
    throw new Error("STATE_INTEGRITY_FAILED");
  return destination;
}
