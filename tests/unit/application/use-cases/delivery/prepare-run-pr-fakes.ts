import type { PrepareRunPrDependencies } from "../../../../../src/application/use-cases/delivery/prepare-run-pr.ts";
import type { AttemptRecord } from "../../../../../src/application/ports/attempt-store.ts";
import { preparationHarness, request } from "./prepare-pr-fakes.ts";

export function runPreparation() {
  const h = preparationHarness();
  const attempt: AttemptRecord = {
    id: "a",
    runId: "r",
    stepRunId: "s",
    stepId: "implement",
    attemptNumber: 1,
    status: "succeeded",
    executor: "codex",
    access: "workspace-write",
    role: { id: "developer", version: 1, sha256: "a".repeat(64) },
    skills: [],
    rules: [],
    contextPacket: { path: "packet.json", sha256: "a".repeat(64) },
    artifactRoot: "attempts/a",
    requiredChecks: [],
    startedAt: "2026-11-14T00:00:00.000Z",
    workspace: {
      taskId: request.taskId,
      slug: "task",
      path: "/work/task",
      branch: request.head,
      owner: "runtime",
      leaseKey: "writer",
      generation: 1,
    },
  };
  const deps: PrepareRunPrDependencies = {
    runs: {
      get: () => ({ id: "r", status: "running", version: 1 }),
      listSteps: () => [
        { id: "s", runId: "r", stepId: "implement", status: "succeeded", version: 1 },
      ],
    },
    plans: { forRun: () => ({ ...request, templateHash: "a".repeat(64) }) },
    attempts: { latestForStep: () => attempt },
    workspaces: {
      inspect: () => ({
        ok: true,
        value: {
          path: attempt.workspace.path,
          branch: request.head,
          headSha: "a".repeat(40),
          dirty: false,
          hasIgnoredFiles: false,
        },
      }),
    },
    prepare: h.deps,
  };
  return { ...h, deps, attempt };
}
