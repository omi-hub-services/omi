// Repository counterpart of the runtime regression runner (ADR-0042 decision 2): the
// Coordinator, not the worker, runs the worker's regression test on the base with the fix files
// reverted and on the head, and records the exit codes. The output is the file
// `review-comment --regression-evidence` reads.
import { writeFileSync } from "node:fs";
import { BASE_BRANCH } from "./coordinator-settings.ts";
import "../register-ts-imports.ts";
const { regressionTestSchema } = await import("../../src/application/contracts/result.ts");
const { produceRegressionEvidence } =
  await import("../../src/application/services/produce-regression-evidence.ts");
const { validRegressionEvidence } =
  await import("../../src/application/services/validate-review-evidence.ts");
const { createRegressionExecutor } =
  await import("../../src/infrastructure/processes/regression-executor.ts");
const { gitCommand } = await import("../../src/infrastructure/git/git-command.ts");

type Executor = Parameters<typeof produceRegressionEvidence>[2];

/** The test file picks the repository's runner; the name is appended as `-t <name>`. */
const COMMANDS: readonly (readonly [string, readonly string[]])[] = [
  ["tests/unit/", ["npm", "run", "test:unit", "--"]],
  ["tests/integration/", ["npm", "run", "test:integration", "--"]],
];

export function regressionCommand(file: string): readonly string[] | undefined {
  return COMMANDS.find(([prefix]) => file.startsWith(prefix))?.[1];
}

export interface RegressionEvidenceInput {
  readonly worktree: string;
  readonly testFile: string;
  readonly testName: string;
  readonly out: string;
  /** Full SHA the fix files are reverted to; defaults to the merge-base with origin/develop. */
  readonly base?: string;
  readonly timeoutMs?: number;
  /** Replaces the git/process executor in tests. */
  readonly execute?: Executor;
}

export async function regressionEvidenceCommand(input: RegressionEvidenceInput): Promise<number> {
  const label = "regression-evidence";
  const test = regressionTestSchema.safeParse({ file: input.testFile, name: input.testName });
  const command = test.success ? regressionCommand(test.data.file) : undefined;
  if (!test.success || command === undefined) {
    console.error(
      `${label}: refused: the test file must be a relative path under tests/unit/ or tests/integration/ and the name one line`,
    );
    return 1;
  }
  const base =
    input.base ??
    gitCommand(input.worktree, ["merge-base", "HEAD", `origin/${BASE_BRANCH}`]).stdout.trim();
  const execute =
    input.execute ??
    createRegressionExecutor({
      workspacePath: input.worktree,
      baseSha: base,
      testFile: test.data.file,
      timeoutMs: input.timeoutMs ?? 600_000,
    });
  let evidence;
  try {
    evidence = await produceRegressionEvidence(command, test.data, execute);
  } catch (error) {
    console.error(`${label}: refused: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  writeFileSync(input.out, `${JSON.stringify(evidence, null, 2)}\n`);
  const valid = validRegressionEvidence(evidence, evidence.base.revision, evidence.head.revision);
  console.log(
    `${label}: base ${evidence.base.revision.slice(0, 7)} exit ${String(evidence.base.exitCode)}, ` +
      `head ${evidence.head.revision.slice(0, 7)} exit ${String(evidence.head.exitCode)} -> ${input.out}`,
  );
  if (!valid) {
    console.error(`${label}: refused: the test must fail on the base and pass on the head`);
    return 1;
  }
  return 0;
}
