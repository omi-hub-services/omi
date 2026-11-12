export type DispatchPlanningRefusal =
  | "IMPLEMENTATION_MAP_EMPTY"
  | "BUSINESS_APPROVAL_REQUIRED"
  | "PLAN_KEY_REQUIRED"
  | "TASK_NOT_FOUND"
  /** Every profile is below the quota threshold; `detail` is `earliest_reset=<ISO or unknown>`. */
  | "QUOTA_EXHAUSTED";

export class DispatchPlanningError extends Error {
  readonly reason: DispatchPlanningRefusal;
  readonly detail?: string;
  constructor(reason: DispatchPlanningRefusal, detail?: string) {
    super(reason);
    this.reason = reason;
    if (detail !== undefined) this.detail = detail;
  }
}
