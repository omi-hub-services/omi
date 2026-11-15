export type IssueSpecRead =
  | { readonly kind: "ok"; readonly frontmatter: unknown; readonly body: string }
  | { readonly kind: "invalid"; readonly reason: string };

/** One spec file chosen by the operator; bootstrap pins the path, never Issue text. */
export interface IssueSpecFile {
  /** Splits YAML frontmatter from the Markdown body. Frontmatter is returned unvalidated. */
  read(): Promise<IssueSpecRead>;
  /** Appends the allocated Plan Key marker to the file, so a retry reuses the key. */
  recordPlanKeyMarker(marker: string): Promise<void>;
}
