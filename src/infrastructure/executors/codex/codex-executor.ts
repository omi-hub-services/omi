import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executionHandleSchema,
  executionRequestSchema,
  executionResultSchema,
  probeRequestSchema,
  type ExecutionEvent,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type ProbeRequest,
  type ProbeResult,
} from "../../../application/contracts/agent-execution.js";
import {
  AgentExecutorError,
  type AgentExecutor,
} from "../../../application/ports/agent-executor.js";
import { ExecutionEventStream } from "../../processes/execution-event-stream.js";
import { readBoundedText } from "../../processes/read-bounded-text.js";
import {
  startSupervisedProcess,
  type ProcessExit,
  type SupervisedProcess,
} from "../../processes/supervised-process.js";
import { inspectCodexAuth } from "./codex-auth.js";
import { classifyCodexRun } from "./codex-classifier.js";
import { buildCodexEnvironment } from "./codex-environment.js";
import { buildCodexInvocationArgs } from "./codex-invocation.js";
import { probeCodex } from "./codex-probe.js";
import { CodexStreamState } from "./codex-stream.js";

export interface CodexExecutorOptions {
  startProcess?: typeof startSupervisedProcess;
  executable?: string;
  parentEnv?: NodeJS.ProcessEnv;
  graceMs?: number;
  newExecutionId?: () => string;
  /** Synchronous durable process registration before start returns. Failure stops the group. */
  onWorkerStarted?: (attemptId: string, worker: SupervisedProcess) => void;
}

interface Run {
  handle: ExecutionHandle;
  request: ExecutionRequest;
  stream: CodexStreamState;
  events: ExecutionEventStream;
  outputDir: string;
  outputPath: string;
  supervised?: SupervisedProcess;
  result?: Promise<ExecutionResult>;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Codex CLI details end at this adapter. Each attempt owns its process and temporary output. */
export class CodexExecutor implements AgentExecutor {
  readonly executor = "codex" as const;
  private readonly startProcess: typeof startSupervisedProcess;
  private readonly executable: string;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly graceMs: number;
  private readonly newExecutionId: () => string;
  private readonly onWorkerStarted: CodexExecutorOptions["onWorkerStarted"];
  private readonly runs = new Map<string, Run>();

  constructor(options: CodexExecutorOptions = {}) {
    this.startProcess = options.startProcess ?? startSupervisedProcess;
    this.executable = options.executable ?? "codex";
    this.parentEnv = options.parentEnv ?? process.env;
    this.graceMs = options.graceMs ?? 15_000;
    this.newExecutionId = options.newExecutionId ?? randomUUID;
    this.onWorkerStarted = options.onWorkerStarted;
  }

  async probe(request: ProbeRequest): Promise<ProbeResult> {
    const parsed = probeRequestSchema.safeParse(request);
    if (!parsed.success || !isDirectory(parsed.data.profileHome))
      throw new AgentExecutorError("INVALID_REQUEST");
    return probeCodex({
      executable: this.executable,
      env: buildCodexEnvironment(this.parentEnv, parsed.data.profileHome),
      cwd: tmpdir(),
      profileHome: parsed.data.profileHome,
    });
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    const parsed = executionRequestSchema.safeParse(request);
    if (
      !parsed.success ||
      !isDirectory(parsed.data.workspace) ||
      !isDirectory(parsed.data.profileHome)
    ) {
      throw new AgentExecutorError("INVALID_REQUEST");
    }
    const valid = parsed.data;
    // Fail before spawning if the requested file-store profile is absent, API-key or mixed.
    // Expiry/refresh remains entirely the CLI's job; a runtime auth rejection is classified below.
    if ((await inspectCodexAuth(valid.profileHome)) !== "ready")
      throw new AgentExecutorError("INVALID_REQUEST");
    const handle = executionHandleSchema.safeParse({
      executionId: this.newExecutionId(),
      attemptId: valid.attemptId,
      executor: this.executor,
    });
    if (!handle.success || this.runs.has(handle.data.executionId))
      throw new AgentExecutorError("INVALID_REQUEST");
    let outputDir: string;
    try {
      outputDir = await mkdtemp(join(tmpdir(), "omi-codex-output-"));
    } catch {
      throw new AgentExecutorError("SPAWN_FAILED");
    }
    const run: Run = {
      handle: handle.data,
      request: valid,
      stream: new CodexStreamState(),
      events: new ExecutionEventStream(),
      outputDir,
      outputPath: join(outputDir, "message.txt"),
    };
    try {
      run.supervised = await this.startProcess({
        executable: this.executable,
        args: buildCodexInvocationArgs(valid, run.outputPath),
        cwd: valid.workspace,
        env: buildCodexEnvironment(this.parentEnv, valid.profileHome),
        stdin: valid.prompt,
        onStdoutLine: (line) => {
          for (const draft of run.stream.ingest(line)) run.events.publish(draft);
        },
        timeoutMs: valid.timeoutMs,
        graceMs: this.graceMs,
        maxStdoutChars: 256 * 1024 * 1024,
        maxLineChars: 16 * 1024 * 1024,
        maxStderrChars: 64_000,
      });
      this.onWorkerStarted?.(valid.attemptId, run.supervised);
    } catch {
      run.supervised?.cancel("SIGINT", "group");
      if (run.supervised !== undefined) await run.supervised.exit;
      // Preserve the port error if filesystem cleanup itself fails.
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
      throw new AgentExecutorError("SPAWN_FAILED");
    }
    run.result = run.supervised.exit.then((exit) => this.finish(run, exit));
    this.runs.set(run.handle.executionId, run);
    return run.handle;
  }

  async *events(handle: ExecutionHandle): AsyncGenerator<ExecutionEvent, void> {
    yield* this.lookup(handle).events.replay();
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const run = this.lookup(handle);
    run.supervised?.cancel();
    await run.result;
  }

  async collectResult(handle: ExecutionHandle): Promise<ExecutionResult> {
    const run = this.lookup(handle);
    if (run.result === undefined) throw new AgentExecutorError("UNKNOWN_EXECUTION");
    return run.result;
  }

  private lookup(handle: ExecutionHandle): Run {
    const run = this.runs.get(handle.executionId);
    if (
      run === undefined ||
      run.handle.attemptId !== handle.attemptId ||
      handle.executor !== this.executor
    ) {
      throw new AgentExecutorError("UNKNOWN_EXECUTION");
    }
    return run;
  }

  private async finish(run: Run, exit: ProcessExit): Promise<ExecutionResult> {
    let outcome = "failed";
    try {
      const summary = run.stream.summary();
      let classification = classifyCodexRun(summary, exit);
      let finalMessage: string | undefined;
      if (classification.outcome === "succeeded") {
        finalMessage = await readBoundedText(run.outputPath, 400_000);
        if (finalMessage === undefined || finalMessage.length > 100_000) {
          classification = { outcome: "malformed-output", reason: "invalid_output_file" };
          finalMessage = undefined;
        }
      }
      try {
        await rm(run.outputDir, { recursive: true, force: true });
      } catch {
        classification = { outcome: "failed", reason: "output_cleanup_failed" };
        finalMessage = undefined;
      }
      const result = executionResultSchema.parse({
        executionId: run.handle.executionId,
        attemptId: run.handle.attemptId,
        executor: this.executor,
        ...classification,
        exitCode: exit.exitCode,
        signal: exit.signal,
        durationMs: exit.durationMs,
        ...(summary.sessionId === undefined ? {} : { sessionId: summary.sessionId }),
        model: {
          requested: run.request.model,
          ...(summary.model === undefined ? {} : { actual: summary.model }),
        },
        effort: {
          requested: run.request.effort,
          ...(summary.effort === undefined ? {} : { actual: summary.effort }),
        },
        authMode: "subscription",
        numTurns: summary.completedTurns,
        ...(finalMessage === undefined ? {} : { finalMessage }),
        toolsUsed: summary.toolsUsed,
        eventCount: summary.eventCount,
        unparsedLines: summary.unparsedLines,
        escalated: exit.escalated,
        leftoverProcessesKilled: exit.leftoverProcessesKilled,
      });
      outcome = result.outcome;
      return result;
    } finally {
      run.events.finish(outcome);
    }
  }
}
