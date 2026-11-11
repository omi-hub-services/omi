export interface DispatchPlanRequest {
  readonly runId: string;
  readonly stepRunId: string;
  readonly stepId: string;
  readonly taskId: string;
}

/**
 * Turns a ready workflow step into the full dispatch input: profile and model selection, the
 * context packet and access level. It reads trusted project state (config, profiles, the task
 * snapshot), never text the worker or the Issue supplied. The input is validated again by
 * `dispatchStep`, which also fixes `stepRunId`. `undefined` means no plan is possible now (for
 * example no profile has capacity); nothing is dispatched.
 */
export interface DispatchPlanner {
  plan(request: DispatchPlanRequest): Promise<Readonly<Record<string, unknown>> | undefined>;
}
