import type { TaskIssue, TaskItem } from "../../../src/application/contracts/task-import.ts";

export const repository = { owner: "acme", name: "app" };
export const issue: TaskIssue = {
  id: "I_1",
  number: 1,
  repository,
  title: "Implement task import",
  body: "Objective: import tasks. AC: keep scope and dependencies.",
  state: "OPEN",
  updatedAt: "2026-11-11T00:00:00Z",
  milestoneId: "M_1",
  blockedBy: [],
};
export const item: TaskItem = {
  id: "PVTI_1",
  kind: "Issue",
  issueId: "I_1",
  archived: false,
  iterations: [{ fieldId: "PVTIF_1", iterationId: "iteration-1" }],
};
export const request = {
  schemaVersion: 1,
  projectId: "PVT_1",
  repository,
  scope: { kind: "list", issueIds: ["I_1"] },
} as const;
