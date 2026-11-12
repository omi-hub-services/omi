import { z } from "zod";
import { identifierSchema, slugSchema } from "../../../application/contracts/identifiers.js";
import { reworkStateSchema } from "../../../application/contracts/rework.js";
import type {
  OverviewAttempt,
  RunOverview,
  RunOverviewReader,
} from "../../../application/ports/run-overview-reader.js";
import { AGENT_ATTEMPT_STATUSES } from "../../../domain/runs/agent-attempt.js";
import { STEP_STATUSES } from "../../../domain/runs/step-run.js";
import { RUN_STATUSES } from "../../../domain/runs/workflow-run.js";
import type { StateDatabase } from "./sqlite-connection.js";

const runRow = z.object({
  id: identifierSchema,
  task_id: z.string(),
  issue_number: z.number().int().positive(),
  status: z.enum(RUN_STATUSES),
  template_hash: z.string(),
  quality_phase: z.string(),
  failure_count: z.number(),
  architect_intervention_id: z.string().nullable(),
  counted_cycle_ids: z.string(),
  reopen_decision_ids: z.string(),
});
const stepRow = z.object({ stepId: slugSchema, status: z.enum(STEP_STATUSES) });
const attemptRow = z.object({
  stepId: slugSchema,
  id: identifierSchema,
  status: z.enum(AGENT_ATTEMPT_STATUSES),
  executor_id: z.string(),
  model_id: z.string(),
  profile_id: z.string(),
  chosen_effort: z.string().nullable(),
  dispatch_record: z.string().nullable(),
  started_at: z.string(),
});
/** Only what the view needs from the dispatch record; the rest of it is not this reader's to judge. */
const dispatchView = z.object({
  role: z.object({ id: slugSchema }),
  skills: z.array(z.object({ id: slugSchema })),
  rules: z.array(z.object({ id: slugSchema })),
});

/**
 * Read-only view of the runs that are not closed: their rework state, newest step iterations and
 * newest attempts, joined in SQL so the view sees one consistent read. Unknown shapes throw; a
 * view built on a guess would be worse than none.
 */
export function createSqliteRunOverviewReader(db: StateDatabase): RunOverviewReader {
  const runs = db.prepare(
    `SELECT r.id, r.task_id, t.issue_number, r.status, r.template_hash, r.quality_phase,
            r.failure_count, r.architect_intervention_id, r.counted_cycle_ids, r.reopen_decision_ids
       FROM workflow_runs r JOIN task_snapshots t ON t.id = r.task_id
      WHERE r.closed_at IS NULL ORDER BY r.rowid`,
  );
  const newestStep = `s.iteration = (SELECT MAX(iteration) FROM step_runs
      WHERE run_id = s.run_id AND step_key = s.step_key)`;
  const steps = db.prepare(
    `SELECT s.step_key AS stepId, s.status FROM step_runs s
      WHERE s.run_id = ? AND ${newestStep} ORDER BY s.rowid`,
  );
  const attempts = db.prepare(
    `SELECT s.step_key AS stepId, a.id, a.status, a.executor_id, a.model_id, a.profile_id,
            a.chosen_effort, a.dispatch_record, a.started_at
       FROM agent_attempts a JOIN step_runs s ON s.id = a.step_run_id
      WHERE s.run_id = ? AND ${newestStep}
        AND a.attempt_number = (SELECT MAX(attempt_number) FROM agent_attempts
                                 WHERE step_run_id = a.step_run_id)
      ORDER BY s.rowid`,
  );
  const read = (row: z.infer<typeof attemptRow>): OverviewAttempt => {
    const record =
      row.dispatch_record === null
        ? undefined
        : dispatchView.parse(JSON.parse(row.dispatch_record));
    return {
      stepId: row.stepId,
      attemptId: row.id,
      status: row.status,
      executor: row.executor_id,
      profileId: row.profile_id,
      model: row.model_id,
      ...(row.chosen_effort === null ? {} : { effort: row.chosen_effort }),
      ...(record === undefined ? {} : { role: record.role.id }),
      skills: record?.skills.map((skill) => skill.id) ?? [],
      rules: record?.rules.map((rule) => rule.id) ?? [],
      startedAt: row.started_at,
    };
  };
  return {
    listActive() {
      // One transaction: the three reads must describe the same moment of the runtime's state.
      return db.transaction((): RunOverview[] =>
        z
          .array(runRow)
          .parse(runs.all())
          .map((row) => {
            const rework = reworkStateSchema.parse({
              phase: row.quality_phase,
              failedCycles: row.failure_count,
              ...(row.architect_intervention_id === null
                ? {}
                : { architectInterventionId: row.architect_intervention_id }),
              countedCycleIds: JSON.parse(row.counted_cycle_ids) as unknown,
              reopenDecisionIds: JSON.parse(row.reopen_decision_ids) as unknown,
            });
            return {
              runId: row.id,
              taskId: row.task_id,
              issueNumber: row.issue_number,
              status: row.status,
              templateHash: row.template_hash,
              rework: {
                phase: rework.phase,
                failedCycles: rework.failedCycles,
                countedCycleIds: rework.countedCycleIds,
                reopenDecisionIds: rework.reopenDecisionIds,
                ...(rework.architectInterventionId === undefined
                  ? {}
                  : { architectInterventionId: rework.architectInterventionId }),
              },
              steps: z.array(stepRow).parse(steps.all(row.id)),
              attempts: z.array(attemptRow).parse(attempts.all(row.id)).map(read),
            };
          }),
      )();
    },
  };
}
