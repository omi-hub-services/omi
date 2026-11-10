import { readFile } from "node:fs/promises";
import type { TaskStore } from "../../../application/ports/task-store.js";
import type { Task } from "../../../domain/tasks/task.js";

export function createFileTaskStore(path: string): TaskStore {
  return { list: async () => JSON.parse(await readFile(path, "utf8")) as Task[] };
}
