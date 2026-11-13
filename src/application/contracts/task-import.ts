import { z } from "zod";
import { githubIdSchema, projectConfigSchema } from "./project-config.js";
import { sha256Schema } from "./identifiers.js";
import { TASK_STATUSES } from "../../domain/tasks/task-status.js";

export const taskScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("milestone"), milestoneId: githubIdSchema }),
  z.strictObject({
    kind: z.literal("iteration"),
    fieldId: githubIdSchema,
    iterationId: githubIdSchema,
  }),
  z.strictObject({ kind: z.literal("list"), issueIds: z.array(githubIdSchema).max(1000) }),
]);
export const importTaskSelectionSchema = z.strictObject({
  issueNumbers: z.array(z.number().int().positive().max(9_999_999_999)).min(1).max(1000),
});
export const storedTaskImportSchema = z.strictObject({
  snapshots: z.array(
    z.strictObject({
      taskId: z.string(),
      contentHash: sha256Schema,
      outcome: z.enum(["stored", "unchanged"]),
    }),
  ),
});
export const taskIssueSchema = z.strictObject({
  id: githubIdSchema,
  number: z.number().int().positive(),
  repository: projectConfigSchema.shape.repository,
  title: z.string().max(1024),
  body: z.string().max(1_000_000),
  state: z.enum(["OPEN", "CLOSED"]),
  updatedAt: z.iso.datetime(),
  milestoneId: githubIdSchema.nullable(),
  blockedBy: z.array(githubIdSchema).max(1000),
});
export const taskItemSchema = z.strictObject({
  id: githubIdSchema,
  kind: z.enum(["Issue", "DraftIssue", "PullRequest", "Redacted"]),
  issueId: githubIdSchema.nullable(),
  archived: z.boolean(),
  iterations: z.array(z.strictObject({ fieldId: githubIdSchema, iterationId: githubIdSchema })),
});
export const importTasksSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: githubIdSchema,
  repository: projectConfigSchema.shape.repository,
  scope: taskScopeSchema,
});
export const taskSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  issue: taskIssueSchema,
  contentHash: sha256Schema,
});
export const importedTasksSchema = z.strictObject({
  ...importTasksSchema.shape,
  items: z.array(taskItemSchema),
  snapshots: z.array(taskSnapshotSchema),
});
export const selectReadyTasksSchema = z.strictObject({
  imported: importedTasksSchema,
  /** Runtime state, never an Issue body or an inference from Issue closure. */
  states: z.array(
    z.strictObject({
      id: githubIdSchema,
      status: z.enum(TASK_STATUSES),
      priority: z.enum(["P0", "P1", "P2"]).nullable().default(null),
    }),
  ),
  /** Trusted runtime occupancy across the whole project, not just imported scope. */
  activeTaskIds: z.array(githubIdSchema),
  activeWorkers: z.number().int().nonnegative(),
  limits: z
    .strictObject({
      maxTasks: z.number().int().positive().default(2),
      maxWorkers: z.number().int().positive().default(4),
    })
    .prefault({}),
});
export type TaskIssue = z.infer<typeof taskIssueSchema>;
export type TaskItem = z.infer<typeof taskItemSchema>;
export type ImportedTasks = z.infer<typeof importedTasksSchema>;
