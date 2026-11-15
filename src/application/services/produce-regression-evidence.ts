import type { RegressionTest } from "../contracts/result.js";
import type { RegressionExecutor } from "../ports/regression-runner.js";

/**
 * Runs the same regression command on the base and on the head and returns the strict
 * `{base, head}` document `validRegressionEvidence` checks. Red is recorded by this script, never
 * by the worker. A run that never produced an exit status is an error, not a red run.
 */
export async function produceRegressionEvidence(
  command: readonly string[],
  test: RegressionTest,
  run: RegressionExecutor,
) {
  const argv = [...command, test.file, "-t", test.name];
  const base = await run("base", argv);
  const head = await run("head", argv);
  if (base.exitCode === null || head.exitCode === null) throw new Error("REGRESSION_RUN_FAILED");
  return {
    base: { revision: base.revision, command: argv, exitCode: base.exitCode },
    head: { revision: head.revision, command: argv, exitCode: head.exitCode },
  };
}
