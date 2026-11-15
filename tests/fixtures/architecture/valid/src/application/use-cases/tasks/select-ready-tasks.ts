import { isReady } from "../../../domain/tasks/task.js";
import type { TaskStore } from "../../ports/task-store.js";

export async function selectReadyTasks(store: TaskStore) {
  return (await store.list()).filter(isReady);
}
