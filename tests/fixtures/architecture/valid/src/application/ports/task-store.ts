import type { Task } from "../../domain/tasks/task.js";

export interface TaskStore {
  list(): Promise<Task[]>;
}
