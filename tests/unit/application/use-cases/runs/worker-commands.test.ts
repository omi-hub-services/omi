import { describe, expect, it } from "vitest";
import * as bootstrap from "../../../../../src/bootstrap/container.ts";
import { dispatchStep } from "../../../../../src/application/use-cases/runs/dispatch-step.ts";
import { dispatchInput, rig } from "./run-fakes.ts";

async function setup() {
  const r = rig();
  const dispatched = await dispatchStep(r.deps, dispatchInput());
  if (!dispatched.ok) throw new Error(dispatched.reason);
  r.attempts.setStatus(dispatched.attempt.id, "failed");
  let staged = ["src/file.ts"];
  let committed = false;
  r.workspaces.inspect = (path) => ({
    ok: true,
    value: {
      path,
      headSha: "a".repeat(40),
      branch: dispatched.attempt.workspace.branch,
      dirty: true,
      hasIgnoredFiles: false,
    },
  });
  const deps = {
    ...r.deps,
    reports: { read: () => ({ outcome: "succeeded", exitCode: 0, failure: "REVISION_MISSING" }) },
    committer: {
      stagedPaths: () => staged,
      stage: () => undefined,
      commit: () => {
        committed = true;
        return "b".repeat(40);
      },
    },
  };
  return {
    r,
    id: dispatched.attempt.id,
    deps,
    setStaged: (paths: string[]) => {
      staged = paths;
    },
    committed: () => committed,
  };
}
describe("worker commands", () => {
  it("reads the result outcome separately from the worker's claim", async () => {
    const s = await setup();
    const commands = bootstrap.createWorkerCommandUseCases(s.deps);
    expect(commands.readWorkerReport({ attemptId: s.id })).toMatchObject({
      ok: true,
      status: "failed",
      report: { failure: "REVISION_MISSING" },
    });
  });
  it("commits stopped worker output under the packet's scope", async () => {
    const s = await setup();
    const commands = bootstrap.createWorkerCommandUseCases(s.deps);
    expect(commands.commitWorker({ attemptId: s.id, message: "Implement task" })).toMatchObject({
      ok: true,
      headSha: "b".repeat(40),
    });
    expect(s.committed()).toBe(true);
  });
  it("refuses a worker that is still running", async () => {
    const s = await setup();
    s.r.attempts.setStatus(s.id, "running");
    expect(
      bootstrap
        .createWorkerCommandUseCases(s.deps)
        .commitWorker({ attemptId: s.id, message: "Implement" }),
    ).toMatchObject({ ok: false, reason: "WORKER_NOT_STOPPED" });
    expect(s.committed()).toBe(false);
  });
  it.each([[".claude/skills/x/SKILL.md"], ["docs/outside.md"], ["src/.env"], []])(
    "refuses unsafe or empty staged output %j",
    async (...paths) => {
      const s = await setup();
      s.setStaged(paths.flat());
      expect(
        bootstrap
          .createWorkerCommandUseCases(s.deps)
          .commitWorker({ attemptId: s.id, message: "Implement" }),
      ).toMatchObject({ ok: false });
      expect(s.committed()).toBe(false);
    },
  );
});
