/** One run of the regression command. `where` says which tree: the base with the fix reverted, or the head. */
export type RegressionExecutor = (
  where: "base" | "head",
  argv: readonly string[],
) => Promise<{ readonly revision: string; readonly exitCode: number | null }>;

/**
 * Lets the runtime run a worker's regression test itself (ADR-0042), so red/green evidence never
 * rests on a worker's word. The runtime composes the argv and writes the evidence; this port
 * only runs commands on the right trees.
 */
export interface RegressionRunner {
  /** Executable and arguments before the test file and `-t <name>`. */
  readonly command: readonly string[];
  /** `baseSha` is the runtime's own merge-base: the revision the fix files are reverted to. */
  executor(request: {
    readonly workspacePath: string;
    readonly baseSha: string;
    readonly testFile: string;
  }): RegressionExecutor;
}
