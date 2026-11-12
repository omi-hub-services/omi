import { z } from "zod";
import type { LogRetentionSettings } from "../../domain/runs/log-retention-policy.js";

/**
 * `log_retention` in project.yaml (OMI-080): when a Done task's worker logs are archived and how
 * large `archive/` may grow. Absent block = these defaults.
 */
export const logRetentionConfigSchema = z.strictObject({
  recent_minutes: z.number().int().min(0).max(10_080).default(30),
  archive_max_bytes: z
    .number()
    .int()
    .min(0)
    .max(1024 ** 4)
    .default(50 * 1024 * 1024),
  archive_max_age_days: z.number().int().min(1).max(3650).default(30),
});
export type LogRetentionConfig = z.infer<typeof logRetentionConfigSchema>;

export function logRetentionSettings(config: LogRetentionConfig | undefined): LogRetentionSettings {
  const resolved = logRetentionConfigSchema.parse(config ?? {});
  return {
    recentMinutes: resolved.recent_minutes,
    archiveMaxBytes: resolved.archive_max_bytes,
    archiveMaxAgeDays: resolved.archive_max_age_days,
  };
}
