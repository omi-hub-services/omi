export class IntakeError extends Error {
  override readonly name = "IntakeError";
  readonly code: string;
  constructor(code: string) {
    super(`Issue intake failed: ${code}`);
    this.code = code;
  }
}

export interface ProjectField {
  readonly id: string;
  readonly name: string;
  readonly dataType: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
}

export interface IntakeIssue {
  readonly number: number;
  /** REST database id, used by the native sub-issue and blocked-by relationships. */
  readonly id: number;
  readonly title: string;
  readonly body: string;
}

/** Everything the allocation and validation of one new Issue needs, read completely. */
export interface IntakeSnapshot {
  readonly projectId: string;
  readonly fields: readonly ProjectField[];
  /** Every repository Issue, closed ones included; pull requests are excluded. */
  readonly issues: readonly IntakeIssue[];
  /** Plan Key values on Project items, including items without a body marker. */
  readonly projectPlanKeys: readonly (string | null)[];
  readonly milestones: readonly { readonly number: number; readonly title: string }[];
}

export type FieldWrite =
  | { readonly fieldId: string; readonly name: string; readonly optionId: string }
  | { readonly fieldId: string; readonly name: string; readonly text: string };

export interface CreateTaskRequest {
  readonly title: string;
  readonly body: string;
  readonly milestoneNumber: number;
  readonly projectId: string;
  /** Written in order after the Issue joins the Project. */
  readonly fields: readonly FieldWrite[];
  readonly epic: { readonly number: number; readonly id: number };
  readonly blockedBy: readonly { readonly number: number; readonly id: number }[];
}

/**
 * Creates one task Issue and its Project and relationship state. Not atomic: a failure after the
 * Issue exists throws `IntakeError`; the caller keeps the saved Plan Key marker so a retry finds
 * the Issue instead of creating another one.
 */
export interface GithubIntake {
  snapshot(): Promise<IntakeSnapshot>;
  createTask(request: CreateTaskRequest): Promise<{ readonly number: number }>;
}
