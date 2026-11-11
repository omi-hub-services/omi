import { z } from "zod";
import { executionResultSchema } from "../../application/contracts/agent-execution.js";
import { assertCredentialFree } from "../../application/contracts/credential-input.js";
import { identifierSchema } from "../../application/contracts/identifiers.js";
import {
  effortSchema,
  executorSchema,
  modelNameSchema,
} from "../../application/contracts/model-capability.js";
import type { ExecutorSelectionStore } from "../../application/ports/executor-selection-store.js";
import type { ProfileRegistry } from "../../application/ports/profile-registry.js";
import type { AttemptSettings } from "../../domain/runs/agent-attempt.js";
import type { StateDatabase } from "../persistence/sqlite/sqlite-connection.js";
import { runInTransaction } from "../persistence/sqlite/sqlite-transaction.js";

const settingsSchema = z.strictObject({
  executor_id: executorSchema,
  profile_id: identifierSchema,
  model_id: modelNameSchema,
  chosen_effort: effortSchema,
  actual_model: z.string().min(1).max(128).nullable(),
  actual_effort: effortSchema.nullable(),
});

/** The injected registry must share this connection so reads and reservations share a transaction. */
export function createSqliteExecutorSelectionStore(
  db: StateDatabase,
  registry: ProfileRegistry,
): ExecutorSelectionStore {
  const settings = (attemptId: string): AttemptSettings | undefined => {
    identifierSchema.parse(attemptId);
    const row = db
      .prepare(
        `SELECT executor_id, profile_id, model_id, chosen_effort,
      actual_model, actual_effort FROM agent_attempts WHERE id=?`,
      )
      .get(attemptId);
    if (row === undefined) return undefined;
    const parsed = settingsSchema.parse(row);
    assertCredentialFree(parsed);
    return {
      chosen: {
        executor: parsed.executor_id,
        profileId: parsed.profile_id,
        model: parsed.model_id,
        effort: parsed.chosen_effort,
      },
      ...(parsed.actual_model === null ? {} : { actualModel: parsed.actual_model }),
      ...(parsed.actual_effort === null ? {} : { actualEffort: parsed.actual_effort }),
    };
  };
  return {
    settings,
    reserve(attempt, choose) {
      identifierSchema.parse(attempt.id);
      identifierSchema.parse(attempt.stepRunId);
      z.number().int().positive().parse(attempt.number);
      const at = new Date(z.number().int().nonnegative().parse(attempt.at)).toISOString();
      return runInTransaction(db, () => {
        if (db.prepare("SELECT 1 FROM agent_attempts WHERE id=?").get(attempt.id) !== undefined) {
          throw new Error("Attempt already exists");
        }
        const result = choose(registry.list());
        if (result.outcome === "selected") {
          db.prepare(
            `INSERT INTO agent_attempts
            (id, step_run_id, attempt_number, executor_id, model_id, profile_id, chosen_effort, status, started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          ).run(
            attempt.id,
            attempt.stepRunId,
            attempt.number,
            result.candidate.executor,
            result.candidate.model,
            result.candidate.profileId,
            result.effort,
            at,
          );
        }
        return result;
      });
    },
    recordResult(attemptId, input) {
      const result = executionResultSchema.parse(input);
      runInTransaction(db, () => {
        const previous = settings(attemptId);
        if (
          previous === undefined ||
          result.attemptId !== attemptId ||
          previous.chosen.executor !== result.executor ||
          previous.chosen.model !== result.model.requested ||
          previous.chosen.effort !== result.effort.requested
        ) {
          throw new Error("Result disagrees with attempt selection");
        }
        const actualModel = result.model.actual;
        const actualEffort = result.effort.actual;
        assertCredentialFree({ actualModel, actualEffort });
        // Replaying identical facts is safe; conflicting facts may not overwrite history.
        if (
          (previous.actualModel !== undefined && previous.actualModel !== actualModel) ||
          (previous.actualEffort !== undefined && previous.actualEffort !== actualEffort)
        ) {
          throw new Error("Attempt settings already recorded");
        }
        db.prepare("UPDATE agent_attempts SET actual_model=?, actual_effort=? WHERE id=?").run(
          actualModel ?? null,
          actualEffort ?? null,
          attemptId,
        );
      });
    },
  };
}
