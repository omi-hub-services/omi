import { describe, expect, it } from "vitest";
import * as bootstrap from "../../../../../src/bootstrap/container.ts";
import { dispatchStep } from "../../../../../src/application/use-cases/runs/dispatch-step.ts";
import { dispatchInput, rig } from "./run-fakes.ts";
import { GitWorkspaceError } from "../../../../../src/application/ports/git-workspace.ts";
import { createCommandDispatcher } from "../../../../../src/interfaces/ipc/command-dispatcher.ts";
import { runCli } from "../../../../../src/interfaces/cli/commands/create-program.ts";
import { inspectRuntime } from "../../../../../src/application/use-cases/project/inspect-runtime.ts";

async function setup() {
  const r = rig();
  const dispatched = await dispatchStep(r.deps, dispatchInput());
  if (!dispatched.ok) throw new Error(dispatched.reason);
  r.attempts.setStatus(dispatched.attempt.id, "failed");
  let staged = ["src/file.ts"];
  let committed = false;
  let stageCalls = 0;
  r.workspaces.inspect = (path) => ({
    ok: true,
    value: {
      path,
      headSha: (committed ? "b" : "a").repeat(40),
      branch: dispatched.attempt.workspace.branch,
      dirty: true,
      hasIgnoredFiles: false,
    },
  });
  const deps = {
    ...r.deps,
    reports: { read: () => ({ outcome: "succeeded", exitCode: 0, failure: "REVISION_MISSING" }) },
    committer: {
      committedPaths: () => ["src/file.ts"],
      undoCommit: () => {
        committed = false;
        staged = [];
      },
      stagedPaths: () => staged,
      stage: () => {
        stageCalls++;
      },
      unstage: (_workspace: string, paths: readonly string[]) => {
        staged = staged.filter((path) => !paths.includes(path));
      },
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
    stageCalls: () => stageCalls,
    staged: () => staged,
  };
}

async function commitCommand(s: Awaited<ReturnType<typeof setup>>) {
  const handler = createCommandDispatcher({
    ...bootstrap.createWorkerCommandUseCases(s.deps),
    inspectRuntime: () =>
      inspectRuntime({ runtimeVersion: "0", startedAt: "2026-11-11T00:00:00.000Z" }),
  });
  let output = "";
  const code = await runCli(
    ["--json", "commit-worker", "--attempt", s.id, "--message-file", "message.md"],
    {
      sendCommand: ({ command }) => handler(command),
      readText: () => Promise.resolve("Implement task"),
      defaultSocketPath: "/unused",
      timeoutMs: 100,
      version: "0",
      stdout: (text) => {
        output += text;
      },
      stderr: () => undefined,
    },
  );
  return { code, body: JSON.parse(output) as unknown };
}
describe("worker commands", () => {
  it("sends only contract fields when acquiring and releasing a writer", async () => {
    const s = await setup();
    const acquire = s.r.workspaces.acquireWriter.bind(s.r.workspaces);
    const release = s.r.workspaces.releaseWriter.bind(s.r.workspaces);
    s.r.workspaces.acquireWriter = (request) => {
      expect(Object.keys(request).sort()).toEqual(["expiresAt", "now", "owner", "slug", "taskId"]);
      return acquire(request);
    };
    s.r.workspaces.releaseWriter = (request) => {
      expect(Object.keys(request).sort()).toEqual(["generation", "now", "owner", "slug", "taskId"]);
      return release(request);
    };
    expect(await commitCommand(s)).toMatchObject({ code: 0 });
  });

  it("reports a failed writer release instead of claiming commit success", async () => {
    const s = await setup();
    s.r.workspaces.releaseWriter = () => ({
      ok: false,
      error: new GitWorkspaceError("STALE_LEASE"),
    });
    expect(await commitCommand(s)).toMatchObject({
      code: 4,
      body: { error: { message: "WRITER_RELEASE_FAILED: STALE_LEASE" } },
    });
  });

  it("undoes an out-of-scope commit", async () => {
    const s = await setup();
    s.deps.committer.committedPaths = () => ["src/file.ts", "outside.txt"];
    expect(await commitCommand(s)).toMatchObject({
      code: 4,
      body: { error: { message: "UNSAFE_COMMIT" } },
    });
    expect(s.committed()).toBe(false);
    expect(s.r.workspaces.released).toEqual([2]);
  });

  it("preserves the original failure and index when HEAD did not move", async () => {
    const s = await setup();
    const original = new Error("COMMIT_FAILED");
    s.deps.committer.commit = () => {
      throw original;
    };
    expect(() =>
      bootstrap
        .createWorkerCommandUseCases(s.deps)
        .commitWorker({ attemptId: s.id, message: "Implement" }),
    ).toThrow(original);
    expect(s.staged()).toEqual(["src/file.ts"]);
    expect(s.committed()).toBe(false);
    expect(s.r.workspaces.released).toEqual([2]);
  });

  it.each(["commit", "sha", "paths"] as const)(
    "reconciles HEAD after %s fails following commit creation",
    async (phase) => {
      const s = await setup();
      const commit = s.deps.committer.commit;
      const original = new Error("COMMAND_FAILED");
      s.deps.committer.commit = () => {
        const sha = commit();
        if (phase === "commit") throw original;
        return phase === "sha" ? "invalid-sha" : sha;
      };
      if (phase === "paths")
        s.deps.committer.committedPaths = () => {
          throw original;
        };
      expect(() =>
        bootstrap
          .createWorkerCommandUseCases(s.deps)
          .commitWorker({ attemptId: s.id, message: "Implement" }),
      ).toThrow(phase === "sha" ? undefined : original);
      expect(s.committed()).toBe(false);
      expect(s.staged()).toEqual([]);
      expect(s.r.workspaces.released).toEqual([2]);
    },
  );

  it.each(["inspection", "branch", "undo"] as const)(
    "reports %s recovery failure alongside the original error",
    async (phase) => {
      const s = await setup();
      const commit = s.deps.committer.commit;
      const original = new Error("COMMAND_FAILED");
      const recovery = new GitWorkspaceError("GIT_FAILED");
      s.deps.committer.commit = () => {
        commit();
        throw original;
      };
      const inspect = s.r.workspaces.inspect.bind(s.r.workspaces);
      s.r.workspaces.inspect = (path) => {
        if (s.committed() && phase === "inspection") return { ok: false, error: recovery };
        const state = inspect(path);
        return s.committed() && phase === "branch" && state.ok
          ? { ok: true, value: { ...state.value, branch: "task/unexpected" } }
          : state;
      };
      if (phase === "undo")
        s.deps.committer.undoCommit = () => {
          throw recovery;
        };
      let result: unknown;
      try {
        result = bootstrap
          .createWorkerCommandUseCases(s.deps)
          .commitWorker({ attemptId: s.id, message: "Implement" });
      } catch (error) {
        result = error;
      }
      expect(result).toMatchObject({
        ok: false,
        reason: "COMMIT_RECOVERY_FAILED",
      });
      if (
        typeof result !== "object" ||
        result === null ||
        !("error" in result) ||
        !(result.error instanceof AggregateError)
      )
        throw new Error("missing recovery causes");
      expect(result.error.errors[0]).toBe(original);
      if (phase === "branch") expect(result.error.errors[1]).toBeInstanceOf(Error);
      else expect(result.error.errors[1]).toBe(recovery);
      expect(s.committed()).toBe(true);
      expect(s.r.workspaces.released).toEqual([2]);
    },
  );
  it.each(["writer held", "branch mismatch", "unsafe scope", "empty after staging"] as const)(
    "commit-worker refuses %s through the CLI",
    async (scenario) => {
      const s = await setup();
      let reason: string;
      if (scenario === "writer held") {
        s.r.workspaces.acquireWriter = () => ({
          ok: false,
          error: new GitWorkspaceError("WRITER_HELD"),
        });
        reason = "WRITER_HELD";
      } else if (scenario === "branch mismatch") {
        const inspect = s.r.workspaces.inspect.bind(s.r.workspaces);
        s.r.workspaces.inspect = (path) => {
          const state = inspect(path);
          return state.ok
            ? { ok: true, value: { ...state.value, branch: "task/other-owner" } }
            : state;
        };
        reason = "BRANCH_MISMATCH";
      } else if (scenario === "unsafe scope") {
        const attempt = s.r.attempts.get(s.id);
        if (attempt === undefined) throw new Error("missing attempt");
        const bytes = s.r.artifacts.read(attempt.contextPacket);
        const packet = JSON.parse(new TextDecoder().decode(bytes)) as {
          allowedScope: { paths: string[] };
        };
        packet.allowedScope.paths = [".claude"];
        const contextPacket = s.r.artifacts.publish(
          attempt.contextPacket.path,
          JSON.stringify(packet),
        );
        s.r.attempts.rows.set(s.id, { ...attempt, contextPacket });
        reason = "UNSAFE_SCOPE";
      } else {
        s.setStaged([]);
        reason = "NOTHING_TO_COMMIT";
      }
      expect(await commitCommand(s)).toMatchObject({
        code: 4,
        body: { ok: false, error: { code: "COMMAND_REFUSED", message: reason } },
      });
      expect(s.stageCalls()).toBe(scenario === "empty after staging" ? 1 : 0);
      expect(s.committed()).toBe(false);
      expect(s.r.workspaces.released).toHaveLength(
        scenario === "writer held" || scenario === "unsafe scope" ? 0 : 1,
      );
    },
  );

  it("releases the writer lease when commit-worker throws during commit", async () => {
    const s = await setup();
    s.deps.committer.commit = () => {
      throw new Error("COMMIT_FAILED");
    };
    expect(await commitCommand(s)).toMatchObject({
      code: 1,
      body: { ok: false, error: { code: "INTERNAL_ERROR" } },
    });
    expect(s.stageCalls()).toBe(1);
    expect(s.r.workspaces.released).toEqual([2]);
  });

  it("unstages newly pulled unsafe paths while retaining the previous index", async () => {
    const s = await setup();
    s.deps.committer.stage = () => {
      s.setStaged(["src/file.ts", "src/.env"]);
    };
    expect(await commitCommand(s)).toMatchObject({
      code: 4,
      body: { error: { message: "UNSAFE_INDEX" } },
    });
    expect(s.staged()).toEqual(["src/file.ts"]);
    s.deps.committer.stage = () => undefined;
    expect(await commitCommand(s)).toMatchObject({ code: 0 });
  });
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
