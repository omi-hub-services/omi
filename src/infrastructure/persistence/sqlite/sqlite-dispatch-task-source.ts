import { z } from "zod";
import { taskComplexitySchema } from "../../../application/contracts/task-complexity.js";
import type { DispatchTaskSource } from "../../../application/ports/dispatch-task-source.js";
import type { StateDatabase } from "./sqlite-connection.js";
import type { GithubRestClient } from "../../github/github-rest-client.js";
import { createSqliteApprovalStore } from "./sqlite-approval-store.js";

/** Task identity stays in SQLite; Issue content is read from its authoritative GitHub source. */
export function createSqliteDispatchTaskSource(
  db: StateDatabase,
  client: GithubRestClient,
): DispatchTaskSource {
  const approvals = createSqliteApprovalStore(db);
  return {
    async read(taskId) {
      const row = db
        .prepare(
          `SELECT p.repo_identity AS repository, t.issue_number AS number FROM task_snapshots t
        JOIN projects p ON p.id=t.project_id WHERE t.id=?`,
        )
        .get(taskId);
      if (row === undefined) return undefined;
      const task = z
        .object({
          repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
          number: z.number().int().positive(),
        })
        .parse(row);
      const response = await client.request({
        method: "GET",
        path: `/repos/${task.repository}/issues/${String(task.number)}`,
      });
      if (response.kind !== "ok") throw new Error("TASK_SOURCE_UNAVAILABLE");
      const issue = z
        .object({
          number: z.literal(task.number),
          title: z.string().min(1).max(500),
          body: z.string().max(100_000),
          labels: z
            .array(z.object({ name: z.string().max(128) }))
            .max(128)
            .optional(),
        })
        .parse(response.json);
      const candidates = db
        .prepare("SELECT id FROM approvals WHERE kind='business' ORDER BY rowid DESC")
        .all()
        .flatMap((entry) => {
          const { id } = z.object({ id: z.string() }).parse(entry);
          const approval = approvals.get(id);
          return approval === undefined ? [] : [approval];
        });
      return {
        issue: { issueNumber: issue.number, title: issue.title, body: issue.body },
        approvals: candidates,
        complexity: taskComplexitySchema.parse({
          labels: issue.labels?.map((label) => label.name) ?? [],
        }),
      };
    },
  };
}
