// `flow.ts check` with SHA-keyed reuse (OMI-168, ADR-0042): a check that already passed on the
// exact head is not run again; a failed or missing result runs and replaces the stored one.
import { CHECK_ARGV, CHECK_ID, readStoredCheck, storeCheck } from "./check-reuse.ts";
import type { CoordinatorTarget } from "./coordinator-settings.ts";
import type { Plan } from "./flow-plans.ts";
import type { Runner } from "./process-runner.ts";

export interface CheckDeps {
  readonly run: Runner;
  readonly target: CoordinatorTarget;
  /** Executes a plan, appending the command output to `out`; true when it succeeded. */
  readonly exec: (plan: Plan, out: string[]) => Promise<boolean>;
  readonly dryRun: boolean;
  /** The checkout after the run: a pass is only stored for a clean tree still at the key SHA. */
  readonly after: () => Promise<{ readonly head: string; readonly clean: boolean }>;
}

export async function checkWithReuse(deps: CheckDeps, plan: Plan, head: string): Promise<boolean> {
  // Only a runnable plan on a full SHA has a key; a refusal or short SHA just goes through.
  if (plan.kind !== "run" || !/^[a-f0-9]{40}$/.test(head)) return deps.exec(plan, []);
  const stored = await readStoredCheck(deps.run, deps.target, head);
  if (stored?.status === "passed")
    return deps.exec({ kind: "done", note: `reused ${head.slice(0, 7)}` }, []);
  const out: string[] = [];
  const ok = await deps.exec(plan, out);
  if (!deps.dryRun) {
    try {
      // A check that rewrote a tracked file (a formatter) or moved HEAD never seeds a pass.
      if (ok) {
        const after = await deps.after();
        if (!after.clean || after.head !== head) return ok;
      }
      await storeCheck(deps.run, deps.target, {
        checkId: CHECK_ID,
        head,
        command: CHECK_ARGV,
        status: ok ? "passed" : "failed",
        exitCode: ok ? 0 : 1, // shortcut: the exact exit code is not captured; 0/1 is enough for reuse
        log: out.join("\n"),
      });
    } catch (error) {
      // The check result stands; only the reuse is lost.
      console.error(
        `check: could not store the result: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return ok;
}
