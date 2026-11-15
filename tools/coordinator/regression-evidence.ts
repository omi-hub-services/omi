// Repository counterpart of the runtime regression runner (ADR-0042 decision 2): the
// Coordinator, not the worker, runs the worker's regression test on the base with the fix files
// reverted and on the head, and records the exit codes. The output is the file
// `review-comment --regression-evidence` reads.
import { randomUUID } from "node:crypto";
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
  // 126/127: bash cannot execute / find the command; 128+: a signal, a timeout or SETUP_FAILED.
  const exitOf = (code: number) => (code >= 126 ? null : code);
  // The file and argv travel on stdin, NUL-separated, so the payload holds no quote or backslash
  // whatever the test name contains; the test runs as bash's direct child, keeping its exit status.
  const ARGV = "mapfile -d '' -t A; set -f; IFS=;";
  return async (where, argv) => {
    const input = [testFile, ...argv].join("\0");
    if (where === "head") {
      const revision = (await runChecked(run, wslCommand("git rev-parse HEAD", target))).trim();
      const payload = `${WSL_NODE_ENV} ${ARGV} \${A[@]:1}`;
      const result = await run({ ...wslCommand(payload, target, timeoutMs), input });
      return { revision, exitCode: exitOf(result.code) };
    }
    const revision = (
      await runChecked(
        run,
        wslCommand(joinSteps([["git", "rev-parse", "--verify", `${baseSha}^{commit}`]]), target),
      )
    ).trim();
    // The Coordinator owns the temp path, so it can clean up even when the timed run is killed.
    const parent = `/tmp/omi-regression-${randomUUID()}`;
    const tree = `${parent}/base`;
    const payload =
      `${WSL_NODE_ENV} ${ARGV} ` +
      `{ git worktree add --detach ${tree} ${shellQuote(revision)} && ` +
      `cp --parents -- \${A[0]} ${tree} && ` +
      `{ [ ! -d node_modules ] || ln -s ${shellQuote(target.repoDir)}/node_modules ${tree}/node_modules; }; } ` +
      `&& { cd ${tree} && \${A[@]:1}; rc=$?; } || rc=${String(SETUP_FAILED)}; exit $rc`;
    try {
      const result = await run({ ...wslCommand(payload, target, timeoutMs), input });
      return { revision, exitCode: exitOf(result.code) };
    } finally {
      await run(
        wslCommand(`git worktree remove --force ${tree}; rm -rf ${parent}`, target, 60_000),
      ).catch(() => undefined);
    }
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
