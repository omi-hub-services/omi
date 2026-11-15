/** What a curated skill consists of on disk, as read by infrastructure. */
export interface SkillContent {
  /** Skill hash of ADR-0019, recomputed from the bytes read, never copied from a lock. */
  readonly sha256: string;
  /** UTF-8 text of the skill's `SKILL.md`. */
  readonly skillMd: string;
  /** Other files of the skill (`references/`, scripts) as workspace-relative paths. */
  readonly bundledFiles: readonly string[];
}

/** Reads curated skill files; the application never touches the file system itself. */
export interface SkillSource {
  /** `undefined` when the skill is not installed or its files are unreadable. */
  read(id: string, version: string): SkillContent | undefined;
}
