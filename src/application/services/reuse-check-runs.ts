import type { CheckRunRecord } from "../contracts/check-run.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { CheckRunner } from "../ports/check-runner.js";
import type { GitWorkspace } from "../ports/git-workspace.js";

export interface ReuseCheckRunsDependencies {
  readonly artifacts: Pick<ArtifactStore, "read" | "write">;
  readonly workspaces: Pick<GitWorkspace, "inspect">;
  readonly now: () => number;
  readonly nextId: () => string;
}

/**
 * A check that already passed on the exact head with the same command is not run again
 * (ADR-0042): the later step or gate gets the stored result with a copy of its evidence under its
 * own attempt. Keyed by (check id, head SHA, command); only a passed result on a clean worktree
 * is stored, so a failed or timed-out result can never stand in for a pass.
 * shortcut: the store lives in this process, so a restarted runtime re-runs once; upgrade to a
 * persisted store when restarts between steps become common.
 */
export function reuseCheckRuns(inner: CheckRunner, deps: ReuseCheckRunsDependencies): CheckRunner {
  const passed = new Map<string, CheckRunRecord>();
  const keyFor = (checkId: string, workspacePath: string): string | undefined => {
    const command = inner.command?.(checkId);
    const state = deps.workspaces.inspect(workspacePath);
    if (command === undefined || !state.ok || state.value.dirty) return undefined;
    return JSON.stringify([checkId, state.value.headSha, command]);
  };
  return {
    has: (checkId) => inner.has(checkId),
    ...(inner.command === undefined
      ? {}
      : { command: (checkId: string) => inner.command?.(checkId) }),
    async run(request) {
      const key = keyFor(request.checkId, request.workspacePath);
      const stored = key === undefined ? undefined : passed.get(key);
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
      const record = await inner.run(request);
      if (key !== undefined && record.status === "passed" && record.exitCode === 0)
        passed.set(key, record);
      return record;
    },
  };
}
