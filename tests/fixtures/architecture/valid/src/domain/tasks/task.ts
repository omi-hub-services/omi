import type { TaskStatus } from "./task-status.js";

export interface Task {
  readonly id: string;
  readonly status: TaskStatus;
}

export function isReady(task: Task): boolean {
  return task.status === "ready";
}
