export interface OpenPull {
  readonly number: number;
  readonly title: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly draft: boolean;
  /** Data only. The `Issue: #N` line is the task link; nothing else in it is read. */
  readonly body: string;
}

/**
 * Every open pull request of a repository (`owner/name`). The listing is complete or the read
 * throws; a truncated page must never look like "no open PRs".
 */
export interface OpenPullReader {
  listOpen(repository: string): Promise<readonly OpenPull[]>;
}
