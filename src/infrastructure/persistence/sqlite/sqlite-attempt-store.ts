import { z } from "zod";
import { AGENT_ATTEMPT_STATUSES } from "../../../domain/runs/agent-attempt.js";
import { accessLevelSchema } from "../../../application/contracts/agent-execution.js";
import {
  artifactReferenceSchema,
  artifactPathSchema,
} from "../../../application/contracts/artifact.js";
import { contextPacketSchema } from "../../../application/contracts/context.js";
import { assertCredentialFree } from "../../../application/contracts/credential-input.js";
import {
  absolutePathSchema,
  identifierSchema,
  sha256Schema,
  slugSchema,
} from "../../../application/contracts/identifiers.js";
import { effortSchema, executorSchema } from "../../../application/contracts/model-capability.js";
import type { AttemptRecord, AttemptStore } from "../../../application/ports/attempt-store.js";
import type { LeaseFence } from "../../../application/ports/state-unit-of-work.js";
import type { StateDatabase } from "./sqlite-connection.js";
import { runInTransaction } from "./sqlite-transaction.js";

const recordSchema = z.strictObject({
  id: identifierSchema,
  runId: identifierSchema,
  stepRunId: identifierSchema,
  stepId: slugSchema,
  attemptNumber: z.number().int().positive(),
  status: z.enum(AGENT_ATTEMPT_STATUSES),
  executor: executorSchema,
  selection: z
    .strictObject({ model: z.string().min(1), effort: effortSchema, reason: z.string().min(1) })
    .optional(),
  access: accessLevelSchema,
  role: z.strictObject({
    id: slugSchema,
    version: z.number().int().positive(),
    sha256: sha256Schema,
  }),
  skills: contextPacketSchema.shape.skillsManifest,
  rules: contextPacketSchema.shape.rulesManifest,
  contextPacket: artifactReferenceSchema,
  artifactRoot: artifactPathSchema,
  requiredChecks: z.array(slugSchema),
  workspace: z.strictObject({
    taskId: identifierSchema,
    slug: slugSchema,
    path: absolutePathSchema,
    branch: z.string().min(1),
    owner: identifierSchema,
    leaseKey: z.string().min(1),
    generation: z.number().int().positive(),
  }),
  startedAt: z.iso.datetime(),
});
const rowSchema = z.object({
  dispatch_record: z.string().nullable(),
  status: z.enum(AGENT_ATTEMPT_STATUSES),
});

/** Selector reservations and complete dispatch records share one attempt identity and slot. */
export function createSqliteAttemptStore(
  db: StateDatabase,
  options: { readonly fence: LeaseFence; readonly now: () => number },
): AttemptStore & {
  nextNumberForStep(stepRunId: string): number;
  failoversForStep(stepRunId: string): number;
} {
  const assertFence = () => {
    const { resourceKey, owner, generation } = options.fence;
    if (
      db
        .prepare(
          "SELECT 1 FROM leases WHERE resource_key=? AND owner=? AND generation=? AND expires_at>?",
        )
        .get(resourceKey, owner, generation, new Date(options.now()).toISOString()) === undefined
    )
      throw new Error("STALE_LEASE");
  };
  const read = (row: unknown): AttemptRecord | undefined => {
    if (row === undefined) return undefined;
    const value = rowSchema.parse(row);
    if (value.dispatch_record === null) return undefined;
    const record = recordSchema.parse(JSON.parse(value.dispatch_record));
    assertCredentialFree(record);
    const { selection, ...rest } = record;
    return { ...rest, ...(selection === undefined ? {} : { selection }), status: value.status };
  };
  return {
    failoversForStep(stepRunId) {
      const row = db
        .prepare(
          "SELECT count(*) AS count FROM events WHERE kind='step.waiting_resource' AND subject=? AND json_extract(payload, '$.reason')='USAGE_LIMIT'",
        )
        .get(identifierSchema.parse(stepRunId));
      return z.object({ count: z.number().int().nonnegative() }).parse(row).count;
    },
    nextNumberForStep(stepRunId) {
      const row = db
        .prepare(
          "SELECT COALESCE(MAX(attempt_number), 0)+1 AS number FROM agent_attempts WHERE step_run_id=?",
        )
        .get(identifierSchema.parse(stepRunId));
      return z.object({ number: z.number().int().positive() }).parse(row).number;
    },
    reservedNumber(id) {
      const row = db
        .prepare("SELECT attempt_number FROM agent_attempts WHERE id=? AND status='pending'")
        .get(id);
      return row === undefined
        ? undefined
        : z.object({ attempt_number: z.number().int().positive() }).parse(row).attempt_number;
    },
    create(input) {
      const record = recordSchema.parse(input);
      assertCredentialFree(record);
      runInTransaction(db, () => {
        assertFence();
        const existing = db.prepare("SELECT * FROM agent_attempts WHERE id=?").get(record.id);
        if (existing === undefined) throw new Error("ATTEMPT_NOT_RESERVED");
        const reserved = z
          .object({
            step_run_id: z.string(),
            attempt_number: z.number(),
            executor_id: z.string(),
            model_id: z.string(),
            chosen_effort: z.string().nullable(),
            selection_reason: z.string().nullable(),
            status: z.string(),
            dispatch_record: z.string().nullable(),
          })
          .parse(existing);
        if (
          reserved.dispatch_record !== null ||
          reserved.status !== "pending" ||
          record.status !== "pending" ||
          reserved.step_run_id !== record.stepRunId ||
          reserved.attempt_number !== record.attemptNumber ||
          reserved.executor_id !== record.executor ||
          reserved.model_id !== record.selection?.model ||
          reserved.chosen_effort !== record.selection.effort ||
          reserved.selection_reason !== record.selection.reason
        ) {
          throw new Error("ATTEMPT_RESERVATION_MISMATCH");
        }
        db.prepare("UPDATE agent_attempts SET dispatch_record=? WHERE id=?").run(
          JSON.stringify(record),
          record.id,
        );
      });
    },
    get: (id) =>
      read(
        db
          .prepare("SELECT dispatch_record, status FROM agent_attempts WHERE id=?")
          .get(identifierSchema.parse(id)),
      ),
    latestForStep: (id) =>
      read(
        db
          .prepare(
            "SELECT dispatch_record, status FROM agent_attempts WHERE step_run_id=? AND dispatch_record IS NOT NULL ORDER BY attempt_number DESC LIMIT 1",
          )
          .get(identifierSchema.parse(id)),
      ),
    setStatus(id, status) {
      z.enum(AGENT_ATTEMPT_STATUSES).parse(status);
      runInTransaction(db, () => {
        assertFence();
        const updated = db
          .prepare("UPDATE agent_attempts SET status=? WHERE id=?")
          .run(status, identifierSchema.parse(id));
        if (updated.changes !== 1) throw new Error("ATTEMPT_NOT_FOUND");
      });
    },
  };
}
