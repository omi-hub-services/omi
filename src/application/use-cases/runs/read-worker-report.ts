import { z } from "zod";
import { identifierSchema } from "../../contracts/identifiers.js";
import { stepResultSchema } from "../../contracts/result.js";
import type { AttemptStore } from "../../ports/attempt-store.js";
import type { WorkerReportReader } from "../../ports/worker-report-reader.js";

const completedReportSchema = z.object({
  outcome: z.string(),
  exitCode: z.number().int().nullable(),
  failure: z.string().optional(),
  result: stepResultSchema.optional(),
});

const reportSchema = z.union([
  completedReportSchema,
  z.object({ attemptId: identifierSchema, reason: z.string().min(1) }).transform(({ reason }) => ({
    outcome: "failed",
    exitCode: null,
    failure: reason,
  })),
]);

export function readWorkerReport(
  deps: { attempts: AttemptStore; reports: WorkerReportReader },
  input: unknown,
) {
  const parsed = z.strictObject({ attemptId: identifierSchema }).safeParse(input);
  if (!parsed.success) return { ok: false as const, reason: "INVALID_INPUT" };
  const attempt = deps.attempts.get(parsed.data.attemptId);
  if (attempt === undefined) return { ok: false as const, reason: "ATTEMPT_NOT_FOUND" };
  const raw = deps.reports.read(attempt.id);
  return {
    ok: true as const,
    attemptId: attempt.id,
    status: attempt.status,
    executor: attempt.executor,
    report: raw === undefined ? null : reportSchema.parse(raw),
  };
}
