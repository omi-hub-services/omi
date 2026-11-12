// Repository naming compatibility; the framework owns the readiness gate.
import "../register-ts-imports.ts";
import type { TaskReadinessInput } from "../../src/domain/tasks/readiness-gate.ts";
const { READINESS_FIELDS, taskReadinessReasons } =
  await import("../../src/domain/tasks/readiness-gate.ts");
export const ISSUE_FIELDS = READINESS_FIELDS;
export type IssueReadiness = TaskReadinessInput;
export const issueReadinessReasons = taskReadinessReasons;
