import { createFileTaskStore } from "../infrastructure/persistence/sqlite/sqlite-task-store.js";
import { listReadyCommand } from "../interfaces/cli/commands/task-commands.js";

export function runListReady(path: string): Promise<string> {
  return listReadyCommand(createFileTaskStore(path));
}
