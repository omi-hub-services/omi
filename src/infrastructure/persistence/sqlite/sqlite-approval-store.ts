import { z } from "zod";
import { approvalSubjectSchema } from "../../../application/contracts/approval.js";
import { identifierSchema } from "../../../application/contracts/identifiers.js";
import type {
  ApprovalStore,
  ApprovalSubjectReader,
} from "../../../application/ports/approval-store.js";
import { isApprovalSubjectCurrent } from "../../../domain/approvals/approval-policy.js";
import { APPROVAL_STATUSES, approvalSubjectHash } from "../../../domain/approvals/approval.js";
import type { StateDatabase } from "./sqlite-connection.js";

const timestamp = z.number().int().nonnegative();
const storedRequestSchema = z.strictObject({
  id: identifierSchema,
  subjectId: identifierSchema,
  subjectHash: z.string().min(1),
  subject: approvalSubjectSchema,
  status: z.enum(APPROVAL_STATUSES),
  version: z.number().int().nonnegative(),
  requestedAt: timestamp,
  expiresAt: timestamp.optional(),
  runId: identifierSchema.optional(),
  decision: z
    .strictObject({
      id: identifierSchema,
      subject: approvalSubjectSchema,
      decision: z.enum(["approved", "rejected"]),
      actor: z.string().min(1),
      source: z.enum(["po-cli", "github-actor"]),
      evidenceRef: z.string().min(1),
      decidedAt: timestamp,
      expiresAt: timestamp.optional(),
      reason: z.string().optional(),
    })
    .optional(),
});

/** Current imported task revision; unsupported workflow subjects fail closed. */
export function createSqliteTaskApprovalSubjects(db: StateDatabase): ApprovalSubjectReader {
  return {
    read(subjectId, kind) {
      if (kind !== "business") return undefined;
      const row = db.prepare("SELECT content_hash FROM task_snapshots WHERE id=?").get(subjectId);
      if (row === undefined) return undefined;
      const parsed = z.object({ content_hash: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(row);
      return parsed.success
        ? { kind: "business", baselineHash: parsed.data.content_hash, scopeIds: [subjectId] }
        : undefined;
    },
  };
}

export function createSqliteApprovalStore(db: StateDatabase): ApprovalStore {
  return {
    get(id) {
      const row = db
        .prepare(
          "SELECT request_json, status, version, subject_hash, actor, channel, decision, kind FROM approvals WHERE id=?",
        )
        .get(id) as
        | {
            request_json: string | null;
            status: string;
            version: number;
            subject_hash: string;
            actor: string | null;
            channel: string | null;
            decision: string | null;
            kind: string;
          }
        | undefined;
      // Legacy decisions lack the subject/scope provenance needed to authorise execution.
      if (row === undefined || row.request_json === null) return undefined;
      const request = storedRequestSchema.parse(JSON.parse(row.request_json));
      const decision = request.decision;
      if (
        request.id !== id ||
        request.status !== row.status ||
        request.version !== row.version ||
        request.subjectHash !== row.subject_hash ||
        request.subjectHash !== approvalSubjectHash(request.subject) ||
        request.subject.kind !== row.kind ||
        (decision?.actor ?? null) !== row.actor ||
        (decision?.source ?? null) !== row.channel ||
        (decision?.decision ?? null) !== row.decision ||
        ((request.status === "approved" || request.status === "rejected") &&
          decision?.decision !== request.status) ||
        (request.status === "pending" && decision !== undefined) ||
        (decision !== undefined &&
          (decision.id !== request.id ||
            !isApprovalSubjectCurrent(decision.subject, request.subject) ||
            decision.expiresAt !== request.expiresAt))
      ) {
        throw new Error("approval snapshot disagrees with its indexed state");
      }
      return {
        id: request.id,
        subjectId: request.subjectId,
        subjectHash: request.subjectHash,
        subject: request.subject,
        status: request.status,
        version: request.version,
        requestedAt: request.requestedAt,
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
        ...(decision === undefined
          ? {}
          : {
              decision: {
                id: decision.id,
                subject: decision.subject,
                decision: decision.decision,
                actor: decision.actor,
                source: decision.source,
                evidenceRef: decision.evidenceRef,
                decidedAt: decision.decidedAt,
                ...(decision.reason === undefined ? {} : { reason: decision.reason }),
                ...(decision.expiresAt === undefined ? {} : { expiresAt: decision.expiresAt }),
              },
            }),
      };
    },
  };
}
