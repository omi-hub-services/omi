export interface RecordedReview {
  readonly verdict: "pass" | "fail";
  /** The head the independent review judged. */
  readonly headSha: string;
}

/**
 * The newest independent review the runtime recorded for a task, from durable state. It is a
 * reviewer step result, never a PR comment: text posted on GitHub is data, not a verdict.
 */
export interface PullReviewReader {
  latest(issueNumber: number): RecordedReview | undefined;
}
