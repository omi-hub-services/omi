// Contract: ClaudeCodeExecutor against a fake `claude` executable that replays fixtures.
// No real CLI, no login, no quota.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  executionEventSchema,
  executionResultSchema,
  type ExecutionEvent,
  type ExecutionHandle,
  type ExecutionRequest,
} from "../../../../src/application/contracts/agent-execution.js";
import { AgentExecutorError } from "../../../../src/application/ports/agent-executor.js";
import { FORBIDDEN_AUTH_ENV } from "../../../../src/infrastructure/executors/claude-code/claude-code-environment.js";
import type { ProcessExit } from "../../../../src/infrastructure/processes/supervised-process.js";
import {
  ClaudeCodeExecutor,
  type ClaudeCodeExecutorOptions,
} from "../../../../src/infrastructure/executors/claude-code/claude-code-executor.js";
import {
  fixture,
  readInvocations,
  writeFakeClaude,
  type FakeClaudeScenario,
} from "./fake-claude-cli.js";

let root: string;
let workspace: string;
let profileA: string;
let profileB: string;
let counter = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "omi-claude-contract-"));
  workspace = join(root, "workspace");
  profileA = join(root, "profile-a");
  profileB = join(root, "profile-b");
  for (const dir of [workspace, profileA, profileB]) mkdirSync(dir);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The parent environment of the test process: full of things a worker must never inherit. */
const hostileParentEnv: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"] ?? "",
  HOME: "/home/fixture",
  https_proxy: "http://proxy.example.invalid:3128",
  ANTHROPIC_API_KEY: "sk-ant-fixture-must-not-leak",
  ANTHROPIC_AUTH_TOKEN: "fixture-token-must-not-leak",
  CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-must-not-leak",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CONFIG_DIR: "/global/login/that/must/not/be/used",
  GITHUB_TOKEN: "fixture-gh-must-not-leak",
};

interface Harness {
  executor: ClaudeCodeExecutor;
  recordPath: string;
  invocations: () => ReturnType<typeof readInvocations>;
}

function harness(
  scenario: FakeClaudeScenario,
  options: Pick<
    ClaudeCodeExecutorOptions,
    "graceMs" | "executable" | "newExecutionId" | "onWorkerStarted"
  > = {},
): Harness {
  counter += 1;
  const recordPath = join(root, `record-${String(counter)}.jsonl`);
  const executable =
    options.executable ?? writeFakeClaude(root, `claude-${String(counter)}`, scenario, recordPath);
  return {
    executor: new ClaudeCodeExecutor({
      executable,
      parentEnv: hostileParentEnv,
      graceMs: options.graceMs ?? 5000,
      ...(options.onWorkerStarted === undefined
        ? {}
        : { onWorkerStarted: options.onWorkerStarted }),
      ...(options.newExecutionId === undefined ? {} : { newExecutionId: options.newExecutionId }),
    }),
    recordPath,
    invocations: () => readInvocations(recordPath),
  };
}

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    attemptId: "attempt-1",
    workspace,
    profileHome: profileA,
    prompt: "Read the README and report the codename.",
    model: "claude-sonnet-5-5",
    effort: "high",
    access: "read-only",
    timeoutMs: 30_000,
    ...overrides,
  };
}

async function collectEvents(
  executor: ClaudeCodeExecutor,
  handle: ExecutionHandle,
): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const event of executor.events(handle)) events.push(event);
  return events;
}

async function waitForEvent(
  executor: ClaudeCodeExecutor,
  handle: ExecutionHandle,
  kind: ExecutionEvent["kind"],
): Promise<void> {
  for await (const event of executor.events(handle)) {
    if (event.kind === kind) return;
  }
  throw new Error(`run ended without a ${kind} event`);
}

const SUCCESS: FakeClaudeScenario = { stdout: fixture("success.stream.jsonl") };

/** Runs the fake CLI directly, outside the executor, with only the given environment. */
function runFake(
  executable: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { env }, (error, stdout) => {
      if (error === null) resolve({ stdout });
      else reject(new Error(error.message));
    });
    child.stdin?.end();
  });
}

/** The first `count` lines of the success stream: a run that has started but not finished. */
function firstLines(count: number): string {
  return `${fixture("success.stream.jsonl").split("\n").slice(0, count).join("\n")}\n`;
}

describe("port lifecycle on a successful run", () => {
  it("start returns a neutral handle, events stream in order, collectResult classifies", async () => {
    const { executor } = harness(SUCCESS);
    const handle = await executor.start(request());
    expect(handle).toEqual({
      executionId: expect.stringMatching(/^[A-Za-z0-9._-]+$/) as string,
      attemptId: "attempt-1",
      executor: "claude-code",
    });

    const events = await collectEvents(executor, handle);
    expect(events.map((e) => e.kind)).toEqual(["started", "tool-use", "quota-signal", "finished"]);
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    for (const event of events) expect(executionEventSchema.safeParse(event).success).toBe(true);
    expect(events[0]).toMatchObject({ kind: "started", model: "claude-sonnet-5-5" });
    expect(events[1]).toMatchObject({ kind: "tool-use", tool: "Read" });
    expect(events[3]).toMatchObject({ kind: "finished", outcome: "succeeded" });

    const result = await executor.collectResult(handle);
    expect(executionResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      outcome: "succeeded",
      reason: "completed",
      exitCode: 0,
      authMode: "subscription",
      numTurns: 2,
      finalMessage: "The codename is BLUE-HERON-42.",
      toolsUsed: ["Read"],
      unparsedLines: 0,
      escalated: false,
      leftoverProcessesKilled: false,
      attemptId: "attempt-1",
    });
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("records requested and actual model and effort in the result", async () => {
    const { executor } = harness({ stdout: fixture("success-effort-reported.stream.jsonl") });
    const handle = await executor.start(request({ model: "opus", effort: "high" }));
    const result = await executor.collectResult(handle);
    expect(result.model).toEqual({ requested: "opus", actual: "claude-opus-5-5" });
    expect(result.effort).toEqual({ requested: "high", actual: "high" });
  });

  it("leaves `actual` out when the CLI did not report it", async () => {
    const { executor } = harness(SUCCESS);
    const result = await executor.collectResult(await executor.start(request({ effort: "low" })));
    expect(result.model.actual).toBe("claude-sonnet-5-5");
    expect(result.effort).toEqual({ requested: "low" });
  });

  it("events are replayable and collectResult is idempotent", async () => {
    const { executor } = harness(SUCCESS);
    const handle = await executor.start(request());
    const first = await collectEvents(executor, handle);
    const second = await collectEvents(executor, handle);
    expect(second).toEqual(first);
    expect(await executor.collectResult(handle)).toBe(await executor.collectResult(handle));
  });

  it("a consumer that attaches while the run is in progress sees the end", async () => {
    const { executor } = harness({
      ...SUCCESS,
      behaviour: "wait-for-sigint",
      onSigint: fixture("cancelled.stream.jsonl"),
    });
    const handle = await executor.start(request());
    const consumer = collectEvents(executor, handle);
    await waitForEvent(executor, handle, "started");
    await executor.cancel(handle);
    const events = await consumer;
    expect(events.at(-1)).toMatchObject({ kind: "finished", outcome: "cancelled" });
  });
});

describe("invocation", () => {
  it("passes explicit model and effort, no bare mode, no bypass, prompt only on stdin", async () => {
    const { executor, invocations } = harness(SUCCESS);
    const prompt = "line one\n$(rm -rf /) 'quoted' --dangerously-skip-permissions";
    await executor.collectResult(await executor.start(request({ prompt })));
    const [run] = invocations();
    expect(run?.kind).toBe("run");
    expect(run?.argv).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--setting-sources",
      "project,local",
      "--model",
      "claude-sonnet-5-5",
      "--effort",
      "high",
      "--tools",
      "Read,Grep,Glob",
      "--allowedTools",
      "Read,Grep,Glob",
      "--permission-mode",
      "dontAsk",
    ]);
    expect(run?.argv.join(" ")).not.toContain("rm -rf");
    expect(run?.argv).not.toContain("--bare");
    expect(run?.argv).not.toContain("--dangerously-skip-permissions");
    expect(run?.argv).not.toContain("bypassPermissions");
    expect(run?.stdin).toBe(prompt);
    expect(run?.cwd).toBe(workspace);
  });

  it("maps workspace-write to edit tools with acceptEdits, still without shell access", async () => {
    const { executor, invocations } = harness(SUCCESS);
    await executor.collectResult(await executor.start(request({ access: "workspace-write" })));
    const argv = invocations()[0]?.argv ?? [];
    expect(argv).toContain("Read,Edit,Write,Glob,Grep");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(argv.join(" ")).not.toContain("Bash");
  });

  it("grants exactly the absolute artifact directory to a writing worker with --add-dir (OMI-131)", async () => {
    const artifactDir = join(root, "artifact-store", "attempts", "attempt-1");
    mkdirSync(artifactDir, { recursive: true });
    const { executor, invocations } = harness(SUCCESS);
    await executor.collectResult(
      await executor.start(request({ access: "workspace-write", artifactDir })),
    );
    const argv = invocations()[0]?.argv ?? [];
    expect(argv.filter((arg) => arg === "--add-dir")).toHaveLength(1);
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(artifactDir);
    expect(invocations()[0]?.cwd).toBe(workspace);
  });

  it("grants no extra directory to a read-only worker or when none is given", async () => {
    const artifactDir = join(root, "artifact-store", "attempts", "attempt-2");
    mkdirSync(artifactDir, { recursive: true });
    const readOnly = harness(SUCCESS);
    await readOnly.executor.collectResult(await readOnly.executor.start(request({ artifactDir })));
    expect(readOnly.invocations()[0]?.argv).not.toContain("--add-dir");
    const none = harness(SUCCESS);
    await none.executor.collectResult(
      await none.executor.start(request({ access: "workspace-write" })),
    );
    expect(none.invocations()[0]?.argv).not.toContain("--add-dir");
  });

  it("refuses an artifact directory that does not exist as a framework error", async () => {
    const { executor } = harness(SUCCESS);
    await expect(
      executor.start(
        request({ access: "workspace-write", artifactDir: join(root, "missing-artifact-dir") }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("always names the model: the request cannot omit it", async () => {
    const { executor } = harness(SUCCESS);
    const withoutModel: Partial<ExecutionRequest> = request();
    delete withoutModel.model;
    await expect(executor.start(withoutModel as ExecutionRequest)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});

describe("worker isolation (OMI-072): skills only through the prompt", () => {
  it("starts with no native skills, no plugins and no profile auto-memory, as reported by system/init", async () => {
    const { executor } = harness({ ...SUCCESS, initFromLaunch: true });
    const result = await executor.collectResult(await executor.start(request()));
    expect(executionResultSchema.safeParse(result).success).toBe(true);
    expect(result.workerEnvironment).toEqual({ skills: [], plugins: [], memoryPaths: [] });
  });

  it("would report skills, plugins and memory if the launch did not isolate them (control)", async () => {
    // Same fake CLI, launched the way an unisolated worker would be: the init check can fail.
    const recordPath = join(root, "control-record.jsonl");
    const executable = writeFakeClaude(
      root,
      "claude-control",
      { ...SUCCESS, initFromLaunch: true },
      recordPath,
    );
    const { stdout } = await runFake(
      executable,
      ["-p", "--setting-sources", "user,project,local"],
      {
        PATH: process.env["PATH"] ?? "",
        CLAUDE_CONFIG_DIR: profileA,
      },
    );
    const init = stdout
      .split("\n")
      .filter((line) => line.includes('"subtype":"init"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)[0];
    expect(init?.["skills"]).not.toEqual([]);
    expect(init?.["plugins"]).not.toEqual([]);
    expect(init?.["memory_paths"]).not.toEqual({});
  });

  it("leaves the workerEnvironment out when the CLI did not report skills, plugins or memory", async () => {
    const { executor } = harness(SUCCESS);
    const result = await executor.collectResult(await executor.start(request()));
    expect(result).not.toHaveProperty("workerEnvironment");
  });
});

describe("profile isolation (no global auth swapping)", () => {
  it("gives the process only an allowlisted environment with its own CLAUDE_CONFIG_DIR", async () => {
    const { executor, invocations } = harness(SUCCESS);
    const processEnvBefore = { ...process.env };
    const parentBefore = { ...hostileParentEnv };
    await executor.collectResult(await executor.start(request({ profileHome: profileB })));
    const [run] = invocations();
    expect(run?.claudeConfigDir).toBe(profileB);
    expect(run?.disableAutoUpdater).toBe("1");
    expect(run?.disableAutoMemory).toBe("1");
    expect(run?.envKeys).toEqual([
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
      "CLAUDE_CONFIG_DIR",
      "DISABLE_AUTOUPDATER",
      "HOME",
      "PATH",
      "https_proxy",
    ]);
    for (const name of FORBIDDEN_AUTH_ENV) {
      // The parent really has it, and the worker still does not.
      expect(hostileParentEnv).toHaveProperty(name);
      expect(run?.envKeys).not.toContain(name);
    }
    expect(run?.envKeys.some((key) => key.startsWith("ANTHROPIC_"))).toBe(false);
    // The parent session's CLAUDE_CODE_* variables stay out; the one the adapter sets is the
    // auto-memory switch.
    expect(run?.envKeys.filter((key) => key.startsWith("CLAUDE_CODE_"))).toEqual([
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
    ]);
    expect(run?.envKeys).not.toContain("CLAUDECODE");
    expect(run?.envKeys).not.toContain("GITHUB_TOKEN");
    // Nothing global was touched: neither this process's environment nor the parent's.
    expect(process.env).toEqual(processEnvBefore);
    expect(hostileParentEnv).toEqual(parentBefore);
  });

  it("two runs on different profiles overlap, each with its own profile", async () => {
    const a = harness({
      ...SUCCESS,
      behaviour: "wait-for-sigint",
      onSigint: fixture("cancelled.stream.jsonl"),
    });
    const b = harness({
      ...SUCCESS,
      behaviour: "wait-for-sigint",
      onSigint: fixture("cancelled.stream.jsonl"),
    });
    const handleA = await a.executor.start(
      request({ attemptId: "attempt-a", profileHome: profileA }),
    );
    const handleB = await b.executor.start(
      request({ attemptId: "attempt-b", profileHome: profileB }),
    );
    // Both are in flight at once.
    await Promise.all([
      waitForEvent(a.executor, handleA, "started"),
      waitForEvent(b.executor, handleB, "started"),
    ]);
    expect(a.invocations()[0]?.claudeConfigDir).toBe(profileA);
    expect(b.invocations()[0]?.claudeConfigDir).toBe(profileB);
    await Promise.all([a.executor.cancel(handleA), b.executor.cancel(handleB)]);
  });

  it("probe and start use the same per-process environment and never an auth subcommand but status", async () => {
    const { executor, invocations } = harness({
      ...SUCCESS,
      versionOutput: "2.1.322 (Claude Code)\n",
      authStatusOutput: fixture("auth-status-subscription.json"),
    });
    await executor.probe({ profileHome: profileA });
    await executor.collectResult(await executor.start(request({ profileHome: profileA })));
    const all = invocations();
    expect(all.map((i) => i.argv.slice(0, 3))).toEqual([
      ["--version"],
      ["auth", "status", "--json"],
      ["-p", "--output-format", "stream-json"],
    ]);
    for (const invocation of all) expect(invocation.claudeConfigDir).toBe(profileA);
  });
});

describe("a result that cannot be built", () => {
  it("still ends the event stream and wakes waiters, and collectResult rejects", async () => {
    // An id the result contract rejects makes building the result throw after the process ended.
    const { executor } = harness(SUCCESS, { newExecutionId: () => "not a valid id!" });
    const handle = await executor.start(request());
    const events = await collectEvents(executor, handle);
    expect(events.at(-1)).toMatchObject({ kind: "finished", outcome: "failed" });
    await expect(executor.collectResult(handle)).rejects.toThrow();
  });
});

describe("failure classification through the port", () => {
  const cases: {
    name: string;
    scenario: FakeClaudeScenario;
    outcome: string;
    reason: string;
  }[] = [
    {
      name: "usage limit",
      scenario: { stdout: fixture("usage-limit.stream.jsonl"), exitCode: 1 },
      outcome: "usage-limit",
      reason: "usage_limit_reached",
    },
    {
      name: "login required",
      scenario: { stdout: fixture("auth-failure.stream.jsonl"), exitCode: 1 },
      outcome: "auth-required",
      reason: "login_required",
    },
    {
      name: "unsupported model",
      scenario: {
        stdout: fixture("unsupported-model.stream.jsonl"),
        stderr: fixture("unsupported-model.stderr.txt"),
        exitCode: 1,
      },
      outcome: "unsupported-model-or-effort",
      reason: "unsupported_model",
    },
    {
      name: "unsupported effort",
      scenario: { stderr: fixture("unsupported-effort.stderr.txt"), exitCode: 1 },
      outcome: "unsupported-model-or-effort",
      reason: "unsupported_effort",
    },
    {
      name: "malformed output",
      scenario: { stdout: fixture("malformed.stream.jsonl") },
      outcome: "malformed-output",
      reason: "unparsed_stdout",
    },
  ];

  it.each(cases)("$name", async ({ scenario, outcome, reason }) => {
    const { executor } = harness(scenario);
    const handle = await executor.start(request());
    const result = await executor.collectResult(handle);
    expect(executionResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ outcome, reason });
    expect(result.finalMessage).toBeUndefined();
    const events = await collectEvents(executor, handle);
    expect(events.at(-1)).toMatchObject({ kind: "finished", outcome });
  });

  it("reports the reset time of a usage limit for cooldown", async () => {
    const { executor } = harness({ stdout: fixture("usage-limit.stream.jsonl"), exitCode: 1 });
    const result = await executor.collectResult(await executor.start(request()));
    expect(result.quota).toEqual({ limitType: "five_hour", resetsAt: 1794310800 });
    expect(result.diagnostic).toBe("You've hit your limit · resets 3pm");
  });

  it("malformed lines surface as content-free diagnostic events", async () => {
    const { executor } = harness({ stdout: fixture("malformed.stream.jsonl") });
    const handle = await executor.start(request());
    const events = await collectEvents(executor, handle);
    const diagnostics = events.filter((e) => e.kind === "diagnostic");
    expect(diagnostics).toHaveLength(4);
    expect(JSON.stringify(diagnostics)).not.toContain("not json");
    expect((await executor.collectResult(handle)).unparsedLines).toBe(4);
  });
});

describe("cancel", () => {
  const cancelledStream = fixture("cancelled.stream.jsonl");

  it("stops a running worker with SIGINT and reports cancelled without escalation", async () => {
    const { executor } = harness({
      stdout: cancelledStream.split("\n").slice(0, 3).join("\n") + "\n",
      behaviour: "wait-for-sigint",
      onSigint: cancelledStream.split("\n").slice(3).join("\n"),
    });
    const handle = await executor.start(request());
    await waitForEvent(executor, handle, "started");
    await executor.cancel(handle);
    const result = await executor.collectResult(handle);
    expect(result).toMatchObject({
      outcome: "cancelled",
      reason: "cancel_requested",
      exitCode: 0,
      signal: null,
      escalated: false,
    });
  });

  it("kills the process group when the worker ignores the signal", async () => {
    const { executor } = harness(
      {
        stdout: firstLines(3),
        behaviour: "ignore-sigint",
      },
      { graceMs: 300 },
    );
    const handle = await executor.start(request());
    await waitForEvent(executor, handle, "started");
    await executor.cancel(handle);
    const result = await executor.collectResult(handle);
    expect(result).toMatchObject({ outcome: "cancelled", signal: "SIGKILL", escalated: true });
  });

  it("is idempotent and a no-op once the run has finished", async () => {
    const { executor } = harness(SUCCESS);
    const handle = await executor.start(request());
    await executor.collectResult(handle);
    await executor.cancel(handle);
    await executor.cancel(handle);
    expect((await executor.collectResult(handle)).outcome).toBe("succeeded");
  });

  it("a run past its time limit is cancelled and reported as timed out", async () => {
    const { executor } = harness({
      stdout: firstLines(3),
      behaviour: "wait-for-sigint",
      onSigint: cancelledStream.split("\n").slice(3).join("\n"),
    });
    const handle = await executor.start(request({ timeoutMs: 400 }));
    const result = await executor.collectResult(handle);
    expect(result).toMatchObject({ outcome: "timed-out", reason: "timeout", escalated: false });
  });
});

describe("rejected input", () => {
  const bad: [string, Partial<ExecutionRequest>][] = [
    ["a model name that looks like a flag", { model: "--dangerously-skip-permissions" }],
    ["an unknown effort level", { effort: "turbo" as ExecutionRequest["effort"] }],
    ["an unknown access level", { access: "root" as ExecutionRequest["access"] }],
    ["an empty prompt", { prompt: "" }],
    ["a relative workspace", { workspace: "relative/dir" }],
    ["a workspace that does not exist", { workspace: "/nonexistent-omi-dir/workspace" }],
    ["a profile directory that does not exist", { profileHome: "/nonexistent-omi-dir/profile" }],
    ["a zero timeout", { timeoutMs: 0 }],
  ];

  it.each(bad)("start rejects %s before spawning anything", async (_name, overrides) => {
    const { executor, invocations } = harness(SUCCESS);
    const error: unknown = await executor.start(request(overrides)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentExecutorError);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect((error as Error).message).not.toContain("nonexistent-omi-dir");
    expect(invocations()).toEqual([]);
  });

  it("rejects an unknown extra field (strict contract)", async () => {
    const { executor } = harness(SUCCESS);
    const withExtra = { ...request(), apiKey: "x" } as unknown as ExecutionRequest;
    await expect(executor.start(withExtra)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("reports SPAWN_FAILED when the CLI is not installed", async () => {
    const { executor } = harness({}, { executable: join(root, "no-such-claude") });
    await expect(executor.start(request())).rejects.toMatchObject({ code: "SPAWN_FAILED" });
  });

  it("rejects handles it did not issue", async () => {
    const { executor } = harness(SUCCESS);
    const real = await executor.start(request());
    await executor.collectResult(real);
    const forged: ExecutionHandle = { ...real, executionId: "does-not-exist" };
    const unknown = { code: "UNKNOWN_EXECUTION" };
    await expect(collectEvents(executor, forged)).rejects.toMatchObject(unknown);
    await expect(executor.cancel(forged)).rejects.toMatchObject(unknown);
    await expect(executor.collectResult(forged)).rejects.toMatchObject(unknown);
    const otherAttempt: ExecutionHandle = { ...real, attemptId: "attempt-other" };
    await expect(executor.collectResult(otherAttempt)).rejects.toMatchObject(unknown);
  });
});

describe("durable worker process registration", () => {
  it("exposes the owned handle before start resolves", async () => {
    const observed: { attemptId?: string; pid?: number } = {};
    const { executor } = harness(SUCCESS, {
      onWorkerStarted: (attemptId, worker) => {
        observed.attemptId = attemptId;
        observed.pid = worker.pid;
      },
    });
    const handle = await executor.start(request());
    expect(observed.attemptId).toBe(handle.attemptId);
    expect(observed.pid).toBeGreaterThan(0);
    await executor.collectResult(handle);
  });

  it("stops the entire owned group before refusing a failed registration", async () => {
    let exit: Promise<ProcessExit> | undefined;
    const { executor } = harness(SUCCESS, {
      onWorkerStarted: (_attemptId, worker) => {
        exit = worker.exit;
        throw new Error("REGISTRATION_FAILED");
      },
    });
    await expect(executor.start(request())).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(await exit).toMatchObject({ cancelRequested: true });
  });
});
