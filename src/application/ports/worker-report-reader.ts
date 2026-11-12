/** Recorded completion event, not a fresh interpretation of a worker transcript. */
export interface WorkerReportReader {
  read(attemptId: string): unknown;
}
