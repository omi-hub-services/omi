/** Rule bytes read from the installed project, including front matter and whitespace. */
export interface RuleContent {
  /** Recomputed from the file bytes, never copied from the catalog. */
  readonly sha256: string;
  readonly ruleMd: string;
}

export interface RuleSource {
  /** `undefined` when the rule is absent or unreadable; dispatch verifies the pinned hash. */
  read(id: string, version: string): RuleContent | undefined;
}
