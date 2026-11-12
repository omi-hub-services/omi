import { describe, expect, it } from "vitest";
import type { CreateIssueResult } from "../../../../src/application/use-cases/tasks/create-issue-from-spec.ts";
import type { PromoteTaskResult } from "../../../../src/application/use-cases/tasks/promote-task.ts";
import type { SetTaskStatusResult } from "../../../../src/application/use-cases/tasks/set-task-status.ts";
import { runCli } from "../../../../src/interfaces/cli/commands/create-program.ts";
import type { TaskCommands } from "../../../../src/interfaces/cli/commands/task-commands.ts";

const plan = {
  planKey: "OMI-006",
  title: "[OMI-006] Validate a task",
  body: "body",
  fields: { Priority: "P1", Status: "Backlog" },
  milestone: "M1",
  epic: 1,
  blockedBy: [2],
};

function setup(overrides: Partial<TaskCommands> = {}) {
  const calls: Record<string, unknown[]> = { newIssue: [], promote: [], setStatus: [] };
  const tasks: TaskCommands = {
    newIssue: (input) => {
      calls["newIssue"]?.push(input);
      return Promise.resolve<CreateIssueResult>({ kind: "preview", plan });
    },
    promote: (input) => {
      calls["promote"]?.push(input);
      return Promise.resolve<PromoteTaskResult>({ kind: "promoted", issueNumber: 12 });
    },
    setStatus: (input) => {
      calls["setStatus"]?.push(input);
      return Promise.resolve<SetTaskStatusResult>({
        kind: "set",
        issueNumber: 12,
        status: "Ready",
      });
    },
    ...overrides,
  };
  let out = "";
  let err = "";
  const run = async (...argv: string[]) => {
    out = "";
    err = "";
    const code = await runCli(argv, {
      sendCommand: () => Promise.reject(new Error("no runtime needed")),
      defaultSocketPath: "/nowhere.sock",
      timeoutMs: 100,
      version: "0.0.0",
      stdout: (text) => (out += text),
      stderr: (text) => (err += text),
      tasks,
    });
    return { code, out, err };
  };
  return { run, calls };
}

const NEW = ["new-issue", "--project", "/p", "--file", "/p/spec.md"];

describe("new-issue", () => {
  it("previews by default and passes apply=false with the default OMI prefix", async () => {
    const { run, calls } = setup();
    const result = await run(...NEW);
    expect(result.code).toBe(0);
    expect(calls["newIssue"]).toEqual([
      { projectDir: "/p", file: "/p/spec.md", prefix: "OMI", apply: false },
    ]);
    expect(result.out).toContain("preview: OMI-006");
    expect(result.out).toContain("--apply");
    expect(result.out).toContain("milestone: M1");
    expect(result.out).toContain("blocked by: #2");
  });

  it("prints the created Issue and its key", async () => {
    const { run } = setup({
      newIssue: () =>
        Promise.resolve<CreateIssueResult>({ kind: "created", plan, issueNumber: 100 }),
    });
    expect(await run(...NEW, "--apply")).toMatchObject({
      code: 0,
      out: "created: #100 OMI-006\n",
    });
  });

  it("passes apply=true and the --prefix to the use case", async () => {
    const { run, calls } = setup();
    await run(...NEW, "--apply", "--prefix", "ACME");
    expect(calls["newIssue"]).toEqual([
      { projectDir: "/p", file: "/p/spec.md", prefix: "ACME", apply: true },
    ]);
  });

  it("reports an existing Issue as done with exit 0", async () => {
    const { run } = setup({
      newIssue: () =>
        Promise.resolve<CreateIssueResult>({ kind: "exists", planKey: "OMI-005", issueNumber: 2 }),
    });
    expect(await run(...NEW, "--apply")).toMatchObject({
      code: 0,
      out: "done: OMI-005 exists on #2\n",
    });
  });

  it("refuses with every reason and exit 4", async () => {
    const { run } = setup({
      newIssue: () => Promise.resolve<CreateIssueResult>({ kind: "refused", reasons: ["a", "b"] }),
    });
    expect(await run(...NEW)).toMatchObject({
      code: 4,
      err: "error[COMMAND_REFUSED]: a; b\n",
    });
  });

  it("prints the plan as one JSON document with --json", async () => {
    const { run } = setup();
    const result = await run("--json", ...NEW);
    expect(JSON.parse(result.out)).toMatchObject({
      ok: true,
      result: { kind: "preview", plan: { planKey: "OMI-006" } },
    });
  });

  it("is a usage error without --file, and for a bad prefix", async () => {
    const { run, calls } = setup();
    expect((await run("new-issue", "--project", "/p")).code).toBe(2);
    expect((await run(...NEW, "--prefix", "omi")).code).toBe(2);
    expect(calls["newIssue"]).toEqual([]);
  });

  it("reports an adapter failure as exit 1 without raw details", async () => {
    const { run } = setup({
      newIssue: () => Promise.reject(new Error("Issue intake failed: HTTP_500")),
    });
    expect(await run(...NEW, "--apply")).toMatchObject({
      code: 1,
      err: "error[INTERNAL_ERROR]: Issue intake failed: HTTP_500\n",
    });
  });
});

describe("promote", () => {
  it("promotes the first eligible Issue when no number is given", async () => {
    const { run, calls } = setup();
    const result = await run("promote", "--project", "/p");
    expect(calls["promote"]).toEqual([{ projectDir: "/p", dryRun: false }]);
    expect(result).toMatchObject({ code: 0, out: "promoted: #12\n" });
  });

  it("passes the Issue number and --dry-run", async () => {
    const { run, calls } = setup({
      promote: () => Promise.resolve<PromoteTaskResult>({ kind: "would_promote", issueNumber: 12 }),
    });
    const result = await run("promote", "12", "--project", "/p", "--dry-run");
    expect(result.out).toBe("would promote: #12 (dry run, nothing written)\n");
    expect(calls["promote"]).toEqual([]);
  });

  it("sends the Issue number and dry-run flag to the use case", async () => {
    const { run, calls } = setup();
    await run("promote", "12", "--project", "/p", "--dry-run");
    expect(calls["promote"]).toEqual([{ projectDir: "/p", issueNumber: 12, dryRun: true }]);
  });

  it("says nothing is eligible and exits 0", async () => {
    const { run } = setup({ promote: () => Promise.resolve<PromoteTaskResult>({ kind: "none" }) });
    expect(await run("promote", "--project", "/p")).toMatchObject({
      code: 0,
      out: "none: no Backlog task is ready to promote\n",
    });
  });

  it("reports an already Ready Issue as done", async () => {
    const { run } = setup({
      promote: () =>
        Promise.resolve<PromoteTaskResult>({ kind: "done", note: "#12 Status is already Ready" }),
    });
    expect(await run("promote", "12", "--project", "/p")).toMatchObject({
      code: 0,
      out: "done: #12 Status is already Ready\n",
    });
  });

  it("refuses with the reason and exit 4", async () => {
    const { run } = setup({
      promote: () =>
        Promise.resolve<PromoteTaskResult>({ kind: "refused", reason: "#12: blocked by #3" }),
    });
    expect(await run("promote", "12", "--project", "/p")).toMatchObject({
      code: 4,
      err: "error[COMMAND_REFUSED]: #12: blocked by #3\n",
    });
  });

  it("is a usage error for a number that is not a whole Issue number", async () => {
    const { run, calls } = setup();
    expect((await run("promote", "1e3", "--project", "/p")).code).toBe(2);
    expect((await run("promote", "0", "--project", "/p")).code).toBe(2);
    expect(calls["promote"]).toEqual([]);
  });
});

describe("set-status", () => {
  it("sets a gated status", async () => {
    const { run, calls } = setup();
    const result = await run("set-status", "12", "In Progress", "--project", "/p");
    expect(calls["setStatus"]).toEqual([
      { projectDir: "/p", issueNumber: 12, status: "In Progress" },
    ]);
    expect(result).toMatchObject({ code: 0, out: "set: #12 Ready\n" });
  });

  it("reports done when the Issue is already there", async () => {
    const { run } = setup({
      setStatus: () =>
        Promise.resolve<SetTaskStatusResult>({ kind: "done", issueNumber: 12, status: "Ready" }),
    });
    expect((await run("set-status", "12", "Ready", "--project", "/p")).out).toBe(
      "done: #12 is already Ready\n",
    );
  });

  it("refuses with every reason and exit 4", async () => {
    const { run } = setup({
      setStatus: () =>
        Promise.resolve<SetTaskStatusResult>({
          kind: "refused",
          reasons: ["missing Role", "missing Area"],
        }),
    });
    expect(await run("set-status", "12", "Ready", "--project", "/p")).toMatchObject({
      code: 4,
      err: "error[COMMAND_REFUSED]: missing Role; missing Area\n",
    });
  });

  it("is a usage error for a status that carries no gate or a bad number", async () => {
    const { run, calls } = setup();
    expect((await run("set-status", "12", "Done", "--project", "/p")).code).toBe(2);
    expect((await run("set-status", "abc", "Ready", "--project", "/p")).code).toBe(2);
    expect(calls["setStatus"]).toEqual([]);
  });
});

describe("when the task commands are not wired", () => {
  it("fails with exit 1 instead of pretending", async () => {
    let err = "";
    const code = await runCli(["promote", "--project", "/p"], {
      sendCommand: () => Promise.reject(new Error("unused")),
      defaultSocketPath: "/x",
      timeoutMs: 100,
      version: "0.0.0",
      stdout: () => undefined,
      stderr: (text) => (err += text),
    });
    expect(code).toBe(1);
    expect(err).toContain("TASKS_NOT_WIRED");
  });
});
