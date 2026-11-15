import type { TaskStore } from "../../../application/ports/task-store.js";
import { selectReadyTasks } from "../../../application/use-cases/tasks/select-ready-tasks.js";

export async function listReadyCommand(store: TaskStore): Promise<string> {
  return (await selectReadyTasks(store)).map((t) => t.id).join("\n");
}
