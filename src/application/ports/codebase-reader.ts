/** Read-only view of a target repository root, pinned by bootstrap. Never executes anything. */
export interface CodebaseReader {
  /** Names of regular files directly in the root (no directories, no symlinks). */
  rootFiles(): Promise<readonly string[]>;
  /** Bounded UTF-8 text of a root file, or undefined when it is absent or unreadable. */
  readText(name: string): Promise<string | undefined>;
}
