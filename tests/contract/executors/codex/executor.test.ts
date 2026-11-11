import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executionEventSchema,
  executionResultSchema,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionEvent,
} from "../../../../src/application/contracts/agent-execution.js";
import {
  AgentExecutorError,
  type AgentExecutor,
} from "../../../../src/application/ports/agent-executor.js";
import type { ProcessExit } from "../../../../src/infrastructure/processes/supervised-process.js";
import {
  CodexExecutor,
  type CodexExecutorOptions,
} from "../../../../src/infrastructure/executors/codex/codex-executor.js";
import { FORBIDDEN_AUTH_ENV } from "../../../../src/infrastructure/executors/codex/codex-environment.js";
import {
  fixture,
  readInvocations,
  writeFakeCodex,
  type FakeCodexScenario,
} from "./fake-codex-cli.js";

let root: string;
let workspace: string;
let profile: string;
let counter = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omi-codex-contract-"));
  workspace = join(root, "workspace");
  profile = join(root, "profile");
  mkdirSync(workspace);
  mkdirSync(profile);
  writeFileSync(join(profile, "auth.json"), fixture("subscription-cache.json"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const parent: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"] ?? "",
  HOME: "/home/fixture",
  https_proxy: "http://proxy.example.invalid",
  OPENAI_API_KEY: "synthetic-key",
  CODEX_API_KEY: "synthetic-key",
  OPENAI_AUTH_TOKEN: "synthetic-token",
  OPENAI_BASE_URL: "https://provider.example.invalid",
  CODEX_HOME: "/wrong/global/profile",
  CODEX_THREAD_ID: "parent-session",
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "parent",
  ANTHROPIC_API_KEY: "synthetic-other-key",
  GITHUB_TOKEN: "synthetic-github",
};

const SUCCESS: FakeCodexScenario = { stdout: fixture("success.stream.jsonl") };
const STARTED = '{"type":"thread.started","thread_id":"thread-cancel"}\n{"type":"turn.started"}\n';

function harness(
  scenario: FakeCodexScenario = SUCCESS,
  options: Pick<CodexExecutorOptions, "graceMs" | "executable" | "onWorkerStarted"> = {},
) {
  counter += 1;
  const recordPath = join(root, `record-${String(counter)}.jsonl`);
  const executable =
    options.executable ?? writeFakeCodex(root, `codex-${String(counter)}`, scenario, recordPath);
  const executor: AgentExecutor = new CodexExecutor({
    executable,
    parentEnv: parent,
    graceMs: options.graceMs ?? 3000,
    ...(options.onWorkerStarted === undefined ? {} : { onWorkerStarted: options.onWorkerStarted }),
  });
  return { executor, invocations: () => readInvocations(recordPath) };
}

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    attemptId: "attempt-codex",
    workspace,
    profileHome: profile,
    prompt: "Read README.md.",
    model: "gpt-5.3-codex",
    effort: "high",
    access: "read-only",
    timeoutMs: 30_000,
    ...overrides,
  };
}

async function events(executor: AgentExecutor, handle: ExecutionHandle): Promise<ExecutionEvent[]> {
  const result: ExecutionEvent[] = [];
  for await (const event of executor.events(handle)) result.push(event);
  return result;
}

async function started(executor: AgentExecutor, handle: ExecutionHandle): Promise<void> {
  for await (const event of executor.events(handle)) if (event.kind === "started") return;
  throw new Error("worker ended before starting");
}

describe("Codex through the neutral port", () => {
  it("streams neutral ordered events and returns the final output file, with replay and idempotent result", async () => {
    const { executor, invocations } = harness();
    const handle = await executor.start(request());
    expect(Object.keys(handle).sort()).toEqual(["attemptId", "executionId", "executor"]);
    expect(handle.executor).toBe("codex");
    const [first, second, result] = await Promise.all([
      events(executor, handle),
      events(executor, handle),
      executor.collectResult(handle),
    ]);
    expect(first).toEqual(second);
    expect(await events(executor, handle)).toEqual(first);
    expect(await executor.collectResult(handle)).toBe(result);
    expect(first.map((event) => event.kind)).toEqual(["started", "tool-use", "finished"]);
    expect(first.map((event) => event.sequence)).toEqual([0, 1, 2]);
    for (const event of first) expect(executionEventSchema.safeParse(event).success).toBe(true);
    expect(executionResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      outcome: "succeeded",
      reason: "completed",
      authMode: "subscription",
      exitCode: 0,
      numTurns: 1,
      model: { requested: "gpt-5.3-codex" },
      effort: { requested: "high" },
      finalMessage: "The codename is BLUE-HERON-42.",
      toolsUsed: ["command_execution"],
      unparsedLines: 0,
      eventCount: 6,
      escalated: false,
      leftoverProcessesKilled: false,
    });
    expect(result.model.actual).toBeUndefined();
    expect(result.effort.actual).toBeUndefined();
    expect(result.durationMs).toBeGreaterThan(0);
    expect(JSON.stringify(first)).not.toMatch(/cat README|fixture output|Stream message/);
    const argv = invocations()[0]?.argv ?? [];
    const outputPath = argv[argv.indexOf("-o") + 1] ?? "";
    expect(dirname(outputPath)).not.toBe(workspace);
    expect(existsSync(dirname(outputPath))).toBe(false);
  });

  it("keeps requested and reported effective model/effort distinct", async () => {
    const { executor } = harness({ stdout: fixture("success-reported-settings.stream.jsonl") });
    const result = await executor.collectResult(
      await executor.start(request({ model: "codex-alias", effort: "high" })),
    );
    expect(result.model).toEqual({ requested: "codex-alias", actual: "gpt-5.3-codex" });
    expect(result.effort).toEqual({ requested: "high", actual: "xhigh" });
  });

  it("passes controlled settings, sandbox, explicit model/effort and stdin without shell interpolation", async () => {
    const { executor, invocations } = harness();
    const prompt =
      "line one\n$(do-not-execute) `quoted` --dangerously-bypass-approvals-and-sandbox";
    await executor.collectResult(
      await executor.start(request({ prompt, access: "workspace-write" })),
    );
    const run = invocations()[0];
    const argv = run?.argv ?? [];
    expect(argv).toEqual([
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      'model_provider="openai"',
      "-c",
      'approval_policy="never"',
      "-m",
      "gpt-5.3-codex",
      "-c",
      "model_reasoning_effort=high",
      "-C",
      workspace,
      "-s",
      "workspace-write",
      "-o",
      expect.any(String),
      "-",
    ]);
    expect(run?.stdin).toBe(prompt);
    expect(run?.cwd).toBe(workspace);
    expect(argv.join(" ")).not.toContain("do-not-execute");
  });

  it.each(["low", "medium", "high", "xhigh", "max"] as const)(
    "never silently changes requested effort %s",
    async (effort) => {
      const { executor, invocations } = harness(
        effort === "max"
          ? { stderr: fixture("unsupported-effort.stderr.txt"), exitCode: 1 }
          : SUCCESS,
      );
      const result = await executor.collectResult(await executor.start(request({ effort })));
      expect(invocations()[0]?.argv).toContain(`model_reasoning_effort=${effort}`);
      expect(result.effort).toEqual({ requested: effort });
      expect(result.outcome).toBe(effort === "max" ? "unsupported-model-or-effort" : "succeeded");
    },
  );
});

describe("Codex authentication namespace", () => {
  it("isolates overlapping profiles on one executor and leaves global environment and auth bytes unchanged", async () => {
    const profileB = join(root, "profile-b");
    mkdirSync(profileB);
    const cacheA = fixture("subscription-cache.json");
    const cacheB = cacheA.replaceAll("synthetic-access", "synthetic-second-access");
    writeFileSync(join(profileB, "auth.json"), cacheB);
    const envBefore = { ...process.env };
    const parentBefore = { ...parent };
    const { executor, invocations } = harness({
      stdout: STARTED,
      behaviour: "wait-for-sigint",
      onSigint: fixture("cancelled.stream.jsonl"),
    });
    expect((await executor.probe({ profileHome: profileB })).status).toBe("ready");
    const a = await executor.start(request());
    const b = await executor.start(request({ attemptId: "attempt-b", profileHome: profileB }));
    await Promise.all([started(executor, a), started(executor, b)]);
    const runs = invocations();
    expect(runs[0]?.codexHome).toBe(profileB);
    expect(
      runs
        .slice(1)
        .map((run) => run.codexHome)
        .sort(),
    ).toEqual([profile, profileB].sort());
    for (const run of runs) {
      expect(run.envKeys).toEqual(["CODEX_HOME", "HOME", "PATH", "https_proxy"]);
      for (const name of FORBIDDEN_AUTH_ENV) {
        expect(parent).toHaveProperty(name);
        expect(run.envKeys).not.toContain(name);
      }
      expect(["--version", "exec"]).toContain(run.argv[0]);
    }
    await Promise.all([executor.cancel(a), executor.cancel(b)]);
    expect(readFileSync(join(profile, "auth.json"), "utf8")).toBe(cacheA);
    expect(readFileSync(join(profileB, "auth.json"), "utf8")).toBe(cacheB);
    expect(process.env).toEqual(envBefore);
    expect(parent).toEqual(parentBefore);
  });

  it.each(["api-key-cache.json", "mixed-cache.json"])(
    "refuses %s before spawning, even without a probe",
    async (name) => {
      writeFileSync(join(profile, "auth.json"), fixture(name));
      const { executor, invocations } = harness();
      await expect(executor.start(request())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(invocations()).toEqual([]);
    },
  );
});

describe("failure classification and temporary output lifecycle", () => {
  it.each([
    ["usage-limit.stream.jsonl", 1, "usage-limit", "usage_limit_reached"],
    ["auth-failure.stream.jsonl", 1, "auth-required", "login_required"],
    ["unsupported-model.stream.jsonl", 1, "unsupported-model-or-effort", "unsupported_model"],
    ["malformed.stream.jsonl", 0, "malformed-output", "unparsed_stdout"],
  ])("classifies %s through the port", async (name, exitCode, outcome, reason) => {
    const { executor, invocations } = harness({
      stdout: fixture(name),
      exitCode,
    });
    const handle = await executor.start(request());
    const result = await executor.collectResult(handle);
    expect(result).toMatchObject({ outcome, reason });
    expect(result.finalMessage).toBeUndefined();
    expect(executionResultSchema.safeParse(result).success).toBe(true);
    expect((await events(executor, handle)).at(-1)).toMatchObject({ kind: "finished", outcome });
    const argv = invocations()[0]?.argv ?? [];
    expect(existsSync(dirname(argv[argv.indexOf("-o") + 1] ?? ""))).toBe(false);
  });

  it("uses the exhausted secondary window for cooldown instead of an allowed primary window", async () => {
    const { executor } = harness({ stdout: fixture("usage-limit.stream.jsonl"), exitCode: 1 });
    const handle = await executor.start(request());
    expect((await executor.collectResult(handle)).quota).toEqual({
      limitType: "secondary",
      resetsAt: 1794657600,
    });
    expect(
      (await events(executor, handle)).filter((event) => event.kind === "quota-signal"),
    ).toMatchObject([
      { status: "allowed", limitType: "primary" },
      { status: "rejected", limitType: "secondary" },
    ]);
  });

  it.each(["missing", "oversized", "symlink", "directory", "invalid-utf8"] as const)(
    "rejects a %s output file without hanging or exposing it",
    async (outputKind) => {
      const { executor } = harness({ ...SUCCESS, outputKind });
      const handle = await executor.start(request());
      const consumer = events(executor, handle);
      expect(await executor.collectResult(handle)).toMatchObject({
        outcome: "malformed-output",
        reason: "invalid_output_file",
      });
      expect((await consumer).at(-1)).toMatchObject({
        kind: "finished",
        outcome: "malformed-output",
      });
    },
  );

  it("rejects an overlong message even within the byte budget", async () => {
    const { executor } = harness({ ...SUCCESS, finalMessage: "x".repeat(100_001) });
    expect(await executor.collectResult(await executor.start(request()))).toMatchObject({
      outcome: "malformed-output",
      reason: "invalid_output_file",
    });
  });

  it("redacts and bounds diagnostics; malformed stdout events contain no input text", async () => {
    const stderr =
      'authentication failed Bearer synthetic-bearer refresh_token="synthetic-refresh" person@example.invalid ' +
      "x".repeat(3000);
    const { executor } = harness({
      stdout: fixture("malformed.stream.jsonl"),
      stderr,
      exitCode: 1,
    });
    const handle = await executor.start(request());
    const result = await executor.collectResult(handle);
    expect(result.outcome).toBe("auth-required");
    expect(result.diagnostic?.length).toBeLessThanOrEqual(500);
    expect(result.diagnostic).not.toMatch(/synthetic-bearer|synthetic-refresh|person@example/);
    const diagnostics = (await events(executor, handle)).filter(
      (event) => event.kind === "diagnostic",
    );
    expect(diagnostics).toEqual([{ kind: "diagnostic", sequence: 1, code: "unparsed-output" }]);
    expect(JSON.stringify(result)).not.toContain("synthetic-private-output");
  });

  it("bounds progress while preserving a terminal event and all stream counters", async () => {
    const lines = Array.from({ length: 10_010 }, (_, index) =>
      JSON.stringify({
        type: "item.started",
        item: { id: `item-${String(index)}`, type: "command_execution" },
      }),
    );
    const { executor } = harness({
      stdout: STARTED + lines.join("\n") + '\n{"type":"turn.completed"}\n',
    });
    const handle = await executor.start(request());
    const progress = await events(executor, handle);
    expect(progress).toHaveLength(10_000);
    expect(progress.at(-1)).toEqual({ kind: "finished", sequence: 9999, outcome: "succeeded" });
    expect((await executor.collectResult(handle)).eventCount).toBe(10_013);
  });
});

describe("cancellation", () => {
  it("handles SIGINT immediately after started, finishes existing consumers and is idempotent", async () => {
    const { executor, invocations } = harness({
      stdout: STARTED,
      behaviour: "wait-for-sigint",
      onSigint: fixture("cancelled.stream.jsonl"),
    });
    const handle = await executor.start(request());
    const consumer = events(executor, handle);
    await started(executor, handle);
    await Promise.all([executor.cancel(handle), executor.cancel(handle)]);
    expect(await executor.collectResult(handle)).toMatchObject({
      outcome: "cancelled",
      reason: "cancel_requested",
      exitCode: 1,
      escalated: false,
    });
    expect((await consumer).at(-1)).toMatchObject({ kind: "finished", outcome: "cancelled" });
    const argv = invocations()[0]?.argv ?? [];
    expect(existsSync(dirname(argv[argv.indexOf("-o") + 1] ?? ""))).toBe(false);
  });

  it("escalates to group SIGKILL when SIGINT is ignored", async () => {
    const { executor } = harness({ stdout: STARTED, behaviour: "ignore-sigint" }, { graceMs: 200 });
    const handle = await executor.start(request());
    await started(executor, handle);
    await executor.cancel(handle);
    expect(await executor.collectResult(handle)).toMatchObject({
      outcome: "cancelled",
      signal: "SIGKILL",
      escalated: true,
    });
  });

  it("classifies a maximum runtime timeout separately", async () => {
    const { executor } = harness({
      stdout: STARTED,
      behaviour: "wait-for-sigint",
      onSigint: fixture("cancelled.stream.jsonl"),
    });
    const handle = await executor.start(request({ timeoutMs: 1500 }));
    expect(await executor.collectResult(handle)).toMatchObject({
      outcome: "timed-out",
      reason: "timeout",
      escalated: false,
    });
  });

  it("cancel after completion preserves success", async () => {
    const { executor } = harness();
    const handle = await executor.start(request());
    await executor.collectResult(handle);
    await executor.cancel(handle);
    expect((await executor.collectResult(handle)).outcome).toBe("succeeded");
  });
});

describe("request and handle boundary", () => {
  it.each([
    { model: "--flag" },
    { effort: "turbo" },
    { prompt: "" },
    { workspace: "relative" },
    { profileHome: "/nonexistent-omi/profile" },
    { workspace: "/nonexistent-omi/workspace" },
    { timeoutMs: 0 },
    { access: "danger-full-access" },
    { apiKey: "synthetic" },
    { model: undefined },
  ])("rejects invalid input before spawning: %j", async (override) => {
    const { executor, invocations } = harness();
    const error: unknown = await executor
      .start({ ...request(), ...override } as ExecutionRequest)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AgentExecutorError);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(invocations()).toEqual([]);
    expect((error as Error).message).not.toContain("nonexistent-omi");
  });

  it("reports a missing executable as SPAWN_FAILED", async () => {
    const { executor } = harness({}, { executable: join(root, "missing-codex") });
    await expect(executor.start(request())).rejects.toMatchObject({ code: "SPAWN_FAILED" });
  });

  it("rejects forged, cross-executor and cross-instance handles", async () => {
    const { executor } = harness();
    const real = await executor.start(request());
    await executor.collectResult(real);
    for (const forged of [
      { ...real, executionId: "unknown" },
      { ...real, attemptId: "other" },
      { ...real, executor: "claude-code" as const },
    ]) {
      await expect(events(executor, forged)).rejects.toMatchObject({ code: "UNKNOWN_EXECUTION" });
      await expect(executor.cancel(forged)).rejects.toMatchObject({ code: "UNKNOWN_EXECUTION" });
      await expect(executor.collectResult(forged)).rejects.toMatchObject({
        code: "UNKNOWN_EXECUTION",
      });
    }
    await expect(harness().executor.collectResult(real)).rejects.toMatchObject({
      code: "UNKNOWN_EXECUTION",
    });
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
