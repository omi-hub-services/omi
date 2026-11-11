import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  executionRequestSchema,
  executionResultSchema,
  probeRequestSchema,
  executionEventSchema,
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
import {
  startSupervisedProcess,
  type ProcessExit,
  type SupervisedProcess,
} from "../../processes/supervised-process.js";
import { classifyClaudeRun } from "./claude-code-classifier.js";
import { buildClaudeCodeEnvironment } from "./claude-code-environment.js";
import { buildClaudeInvocationArgs, type SettingSource } from "./claude-code-invocation.js";
import { probeClaudeCode } from "./claude-code-probe.js";
import { ClaudeStreamState, type ExecutionEventDraft } from "./claude-code-stream.js";
import { SUPPORTED_CLAUDE_CODE_RANGE } from "./claude-code-version.js";

export interface ClaudeCodeExecutorOptions {
  /** CLI to run; resolved through the child's `PATH`. Tests point it at a fake. */
  executable?: string;
  /** Source of the allowlisted variables (`PATH`, proxies, …). Defaults to `process.env`. */
  parentEnv?: NodeJS.ProcessEnv;
  settingSources?: readonly SettingSource[];
  /** Time between the polite cancel signal and killing the process group. */
  graceMs?: number;
  newExecutionId?: () => string;
}

const DEFAULT_GRACE_MS = 15_000;
const MAX_BUFFERED_EVENTS = 10_000;
const LIMITS = {
  maxStdoutChars: 256 * 1024 * 1024,
  maxLineChars: 16 * 1024 * 1024,
  maxStderrChars: 64_000,
} as const;

interface Run {
  readonly handle: ExecutionHandle;
  readonly request: ExecutionRequest;
  readonly stream: ClaudeStreamState;
  readonly events: ExecutionEvent[];
  readonly waiters: (() => void)[];
  nextSequence: number;
  finished: boolean;
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

/**
 * Production Claude Code worker (`claude -p`, stream-json) behind the AgentExecutor port.
 * Flags, events and error text of the CLI stop here (architecture.md §7). Several runs on
 * different profiles may be in flight at once: the profile is a per-process environment value.
 */
export class ClaudeCodeExecutor implements AgentExecutor {
  readonly executor = "claude-code" as const;

  private readonly executable: string;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly settingSources: readonly SettingSource[] | undefined;
  private readonly graceMs: number;
  private readonly newExecutionId: () => string;
  private readonly runs = new Map<string, Run>();

  constructor(options: ClaudeCodeExecutorOptions = {}) {
    this.executable = options.executable ?? "claude";
    this.parentEnv = options.parentEnv ?? process.env;
    this.settingSources = options.settingSources;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.newExecutionId = options.newExecutionId ?? randomUUID;
  }

  async probe(request: ProbeRequest): Promise<ProbeResult> {
    const parsed = probeRequestSchema.safeParse(request);
    if (!parsed.success || !isDirectory(parsed.data.profileHome)) {
      throw new AgentExecutorError("INVALID_REQUEST");
    }
    const fields = await probeClaudeCode({
      executable: this.executable,
      env: buildClaudeCodeEnvironment(this.parentEnv, parsed.data.profileHome),
      cwd: tmpdir(),
    });
    return {
      executor: this.executor,
      supportedRange: SUPPORTED_CLAUDE_CODE_RANGE.description,
      ...fields,
    };
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    const parsed = executionRequestSchema.safeParse(request);
    // A missing profile directory would make the CLI create an empty profile, then report a
    // confusing login error; a missing workspace would run the worker in the wrong place.
    if (
      !parsed.success ||
      !isDirectory(parsed.data.workspace) ||
      !isDirectory(parsed.data.profileHome)
    ) {
      throw new AgentExecutorError("INVALID_REQUEST");
    }
    const valid = parsed.data;
    const handle: ExecutionHandle = {
      executionId: this.newExecutionId(),
      attemptId: valid.attemptId,
      executor: this.executor,
    };
    const run: Run = {
      handle,
      request: valid,
      stream: new ClaudeStreamState(),
      events: [],
      waiters: [],
      nextSequence: 0,
      finished: false,
    };

    let supervised: SupervisedProcess;
    try {
      supervised = await startSupervisedProcess({
        executable: this.executable,
        args: buildClaudeInvocationArgs(valid, {
          ...(this.settingSources === undefined ? {} : { settingSources: this.settingSources }),
        }),
        cwd: valid.workspace,
        env: buildClaudeCodeEnvironment(this.parentEnv, valid.profileHome),
        stdin: valid.prompt,
        onStdoutLine: (line) => {
          for (const draft of run.stream.ingest(line)) this.publish(run, draft);
        },
        timeoutMs: valid.timeoutMs,
        graceMs: this.graceMs,
        ...LIMITS,
      });
    } catch {
      throw new AgentExecutorError("SPAWN_FAILED");
    }
    run.supervised = supervised;
    run.result = supervised.exit.then((exit) => this.finish(run, exit));
    this.runs.set(handle.executionId, run);
    return handle;
  }

  async *events(handle: ExecutionHandle): AsyncGenerator<ExecutionEvent, void> {
    const run = this.lookup(handle);
    let index = 0;
    for (;;) {
      while (index < run.events.length) {
        const event = run.events[index];
        index += 1;
        if (event !== undefined) yield event;
      }
      if (run.finished) return;
      await new Promise<void>((resolve) => run.waiters.push(resolve));
    }
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

  private publish(run: Run, draft: ExecutionEventDraft): void {
    if (run.finished || run.events.length >= MAX_BUFFERED_EVENTS - 1) return;
    run.events.push(executionEventSchema.parse({ ...draft, sequence: run.nextSequence }));
    run.nextSequence += 1;
    this.wake(run);
  }

  private wake(run: Run): void {
    for (const waiter of run.waiters.splice(0)) waiter();
  }

  private finish(run: Run, exit: ProcessExit): ExecutionResult {
    // Whatever happens below, consumers of events() must see the end and waiters must wake.
    let outcome = "failed";
    try {
      const result = this.buildResult(run, exit);
      outcome = result.outcome;
      return result;
    } finally {
      // The terminal event goes in regardless of the buffer cap so a consumer always sees the end.
      run.events.push({ kind: "finished", sequence: run.nextSequence, outcome });
      run.nextSequence += 1;
      run.finished = true;
      this.wake(run);
    }
  }

  private buildResult(run: Run, exit: ProcessExit): ExecutionResult {
    const summary = run.stream.summary();
    const classification = classifyClaudeRun(summary, exit);
    const { request, handle } = run;
    const succeeded = classification.outcome === "succeeded";

    return executionResultSchema.parse({
      executionId: handle.executionId,
      attemptId: handle.attemptId,
      executor: this.executor,
      outcome: classification.outcome,
      reason: classification.reason,
      exitCode: exit.exitCode,
      signal: exit.signal,
      durationMs: exit.durationMs,
      ...(summary.init?.sessionId === undefined ? {} : { sessionId: summary.init.sessionId }),
      model: {
        requested: request.model,
        ...(summary.init?.model === undefined ? {} : { actual: summary.init.model }),
      },
      effort: {
        requested: request.effort,
        ...(summary.init?.effort === undefined ? {} : { actual: summary.init.effort }),
      },
      authMode: classification.authMode,
      ...(summary.result?.numTurns === undefined ? {} : { numTurns: summary.result.numTurns }),
      ...(succeeded && summary.result !== undefined
        ? { finalMessage: summary.result.text.slice(0, 100_000) }
        : {}),
      ...(classification.quota === undefined ? {} : { quota: classification.quota }),
      toolsUsed: summary.toolsUsed,
      eventCount: summary.eventCount,
      unparsedLines: summary.unparsedLines,
      ...(classification.diagnostic === undefined ? {} : { diagnostic: classification.diagnostic }),
      escalated: exit.escalated,
      leftoverProcessesKilled: exit.leftoverProcessesKilled,
    });
  }
}
