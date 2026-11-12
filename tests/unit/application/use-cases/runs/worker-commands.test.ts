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
