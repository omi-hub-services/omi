// Repository counterpart of the runtime regression runner (ADR-0042 decision 2): the
// Coordinator, not the worker, runs the worker's regression test on the base with the fix files
// reverted and on the head, and records the exit codes. The output is the file
// `review-comment --regression-evidence` reads.
import { writeFileSync } from "node:fs";
import { BASE_BRANCH, wslTarget, type WslTarget } from "./coordinator-settings.ts";
import {
  createProcessRunner,
  joinSteps,
  runChecked,
  shellQuote,
  WSL_NODE_ENV,
  wslCommand,
  type Runner,
} from "./process-runner.ts";
import "../register-ts-imports.ts";
const { regressionTestSchema } = await import("../../src/application/contracts/result.ts");
const { produceRegressionEvidence } =
  await import("../../src/application/services/produce-regression-evidence.ts");
const { validRegressionEvidence } =
  await import("../../src/application/services/validate-review-evidence.ts");

type Executor = Parameters<typeof produceRegressionEvidence>[2];

/** The test file picks the repository's runner; the name is appended as `-t <name>`. */
const COMMANDS: readonly (readonly [string, readonly string[]])[] = [
  ["tests/unit/", ["npm", "run", "test:unit", "--"]],
  ["tests/integration/", ["npm", "run", "test:integration", "--"]],
];

export function regressionCommand(file: string): readonly string[] | undefined {
  return COMMANDS.find(([prefix]) => file.startsWith(prefix))?.[1];
}

/** Setup failure in the throwaway worktree; not a test result, so it yields no exit status. */
const SETUP_FAILED = 199;

/** Mirrors createRegressionExecutor, but every git and npm step runs in the WSL checkout. */
function wslRegressionExecutor(
  run: Runner,
  target: WslTarget,
  baseSha: string,
  testFile: string,
  timeoutMs: number,
): Executor {
  const exitOf = (code: number) => (code === SETUP_FAILED || code >= 127 ? null : code);
  return async (where, argv) => {
    const test = joinSteps([argv]);
    if (where === "head") {
      const revision = (await runChecked(run, wslCommand("git rev-parse HEAD", target))).trim();
      const result = await run(wslCommand(`${WSL_NODE_ENV} ${test}`, target, timeoutMs));
      return { revision, exitCode: exitOf(result.code) };
    }
    const revision = (
      await runChecked(
        run,
        wslCommand(joinSteps([["git", "rev-parse", "--verify", `${baseSha}^{commit}`]]), target),
      )
    ).trim();
    const q = shellQuote;
    const tree = "$T/base";
    const dir = testFile.slice(0, testFile.lastIndexOf("/"));
    const payload =
      `T=$(mktemp -d); ` +
      `{ git worktree add --detach ${tree} ${q(revision)} && mkdir -p ${tree}/${q(dir)} && ` +
      `cp ${q(testFile)} ${tree}/${q(testFile)} && ` +
      `{ [ ! -d node_modules ] || ln -s ${q(target.repoDir)}/node_modules ${tree}/node_modules; }; } ` +
      `&& { cd ${tree} && ${WSL_NODE_ENV} ${test}; rc=$?; } || rc=${String(SETUP_FAILED)}; ` +
      `cd ${q(target.repoDir)}; git worktree remove --force ${tree}; rm -rf $T; exit $rc`;
    const result = await run(wslCommand(payload, target, timeoutMs));
    return { revision, exitCode: exitOf(result.code) };
  };
}

export interface RegressionEvidenceInput {
  /** Path inside the WSL checkout; defaults to the configured work checkout. */
  readonly worktree?: string;
  readonly run?: Runner;
  readonly target?: WslTarget;
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
  const timeoutMs = input.timeoutMs ?? 600_000;
  const run = input.run ?? createProcessRunner();
  const target = {
    ...(input.target ?? wslTarget()),
    ...(input.worktree ? { repoDir: input.worktree } : {}),
  };
  let evidence;
  try {
    const base =
      input.base ??
      (
        await runChecked(run, wslCommand(`git merge-base HEAD origin/${BASE_BRANCH}`, target))
      ).trim();
    const execute =
      input.execute ?? wslRegressionExecutor(run, target, base, test.data.file, timeoutMs);
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
