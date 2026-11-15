import type { CheckRunRecord } from "../contracts/check-run.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { CheckResultStore } from "../ports/check-result-store.js";
import type { CheckRunner } from "../ports/check-runner.js";
import type { GitWorkspace } from "../ports/git-workspace.js";

export interface ReuseCheckRunsDependencies {
  readonly artifacts: Pick<ArtifactStore, "read" | "write">;
  /** Persisted in run state, so reuse survives a runtime restart. */
  readonly results: CheckResultStore;
  readonly workspaces: Pick<GitWorkspace, "inspect">;
  readonly now: () => number;
  readonly nextId: () => string;
}

/**
 * A check that already passed on the exact head with the same command is not run again
 * (ADR-0042): the later step or gate gets the stored result with a copy of its evidence under its
 * own attempt. Keyed by (check id, head SHA, command). A pass is stored only when the tree was
 * clean before the run and is still clean at the same HEAD after it, and the record names the
 * same revision and command: a check that rewrote a tracked file never seeds a pass for content
 * it did not test. A failed or timed-out result is never stored or reused.
 */
export function reuseCheckRuns(inner: CheckRunner, deps: ReuseCheckRunsDependencies): CheckRunner {
  const cleanHead = (workspacePath: string): string | undefined => {
    const state = deps.workspaces.inspect(workspacePath);
    return state.ok && !state.value.dirty ? state.value.headSha : undefined;
  };
  return {
    has: (checkId) => inner.has(checkId),
    ...(inner.command === undefined
      ? {}
      : { command: (checkId: string) => inner.command?.(checkId) }),
    async run(request) {
      const command = inner.command?.(request.checkId);
      const head = command === undefined ? undefined : cleanHead(request.workspacePath);
      if (command === undefined || head === undefined) return inner.run(request);
      const stored = deps.results.find(request.checkId, head, command);
      if (stored !== undefined) {
        const path = `${request.artifactRoot}/checks/${request.checkId}.json`;
        if (stored.evidence.path === path) return stored;
        const evidence = deps.artifacts.write({
          id: deps.nextId(),
          path,
          bytes: new Uint8Array(deps.artifacts.read(stored.evidence)),
          producerAttemptId: request.attemptId,
          classification: "check-evidence",
          createdAt: new Date(deps.now()).toISOString(),
        });
        return { ...stored, evidence };
      }
      const record: CheckRunRecord = await inner.run(request);
      if (
        record.status === "passed" &&
        record.exitCode === 0 &&
        record.revision === head &&
        JSON.stringify(record.command) === JSON.stringify(command) &&
        cleanHead(request.workspacePath) === head
      )
        deps.results.save(record);
      return record;
    },
  };
}
