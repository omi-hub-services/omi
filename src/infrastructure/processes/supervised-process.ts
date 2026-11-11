import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface SupervisedProcessOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  /** The complete child environment. Nothing is inherited implicitly. */
  env: Readonly<Record<string, string>>;
  /** Written to stdin, then stdin is closed. Never part of a command line. */
  stdin: string;
  /** Called for each complete stdout line (without the line terminator). */
  onStdoutLine(line: string): void;
  /** Maximum run time. On expiry the process is cancelled like a caller cancel. */
  timeoutMs: number;
  /** Time between the polite signal and killing the process group. */
  graceMs: number;
  /** Characters of stdout accepted in total, and in one line; exceeding either kills the run. */
  maxStdoutChars: number;
  maxLineChars: number;
  maxStderrChars: number;
}

export interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stderr: string;
  /** The caller asked for cancellation while the process was running. */
  cancelRequested: boolean;
  timedOut: boolean;
  /** Stdout exceeded a limit; the group was killed immediately. */
  stdoutOverflow: boolean;
  /** The grace period expired and the process group was killed. */
  escalated: boolean;
  /** Group members were still alive after the child exited and were killed. */
  leftoverProcessesKilled: boolean;
}

/** Who gets the polite signal. The group is always the SIGKILL target after the grace period. */
export type CancelScope = "child" | "group";

export interface SupervisedProcess {
  /** Process id of the child, which is also the id of the process group it leads. */
  readonly pid: number;
  /**
   * Sends `signal` to the child (`scope: "child"`, the default) or to every member of its group
   * (`scope: "group"`, for a worker that runs tool subprocesses), then kills the group after the
   * grace period if it is alive. Idempotent: only the first call has an effect.
   */
  cancel(signal?: NodeJS.Signals, scope?: CancelScope): void;
  readonly exit: Promise<ProcessExit>;
}

function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Starts a child in its own process group: a terminal Ctrl-C does not reach it, and the group
 * (never an executable name) is the only SIGKILL target, and only while it is still alive
 * (tech-stack.md §7, ADR-0013). Durations use a monotonic clock because the WSL2 wall clock
 * jumps. Resolves when the process exists; rejects if it could not be spawned.
 */
export function startSupervisedProcess(
  options: SupervisedProcessOptions,
): Promise<SupervisedProcess> {
  return new Promise((resolveStart, rejectStart) => {
    const startedAt = performance.now();
    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.once("error", rejectStart);
    child.once("spawn", () => {
      child.removeListener("error", rejectStart);
      // After a successful spawn an 'error' means a failed signal or write; 'close' still follows.
      child.on("error", () => undefined);
      const pid = child.pid;
      if (pid === undefined) {
        rejectStart(new Error("child has no pid"));
        return;
      }
      resolveStart(supervise(options, child, pid, startedAt));
    });
  });
}

function supervise(
  options: SupervisedProcessOptions,
  child: ReturnType<typeof spawn>,
  pid: number,
  startedAt: number,
): SupervisedProcess {
  const state = {
    exited: false,
    cancelRequested: false,
    timedOut: false,
    stdoutOverflow: false,
    escalated: false,
    leftoverProcessesKilled: false,
  };
  const timers: NodeJS.Timeout[] = [];
  let stdoutBuffer = "";
  let stdoutChars = 0;
  let stderr = "";

  const stop = (signal: NodeJS.Signals, scope: CancelScope = "child"): void => {
    if (state.exited) return;
    if (scope === "group") killGroup(pid, signal);
    else child.kill(signal);
    timers.push(
      setTimeout(() => {
        if (state.exited || !isGroupAlive(pid)) return;
        state.escalated = true;
        killGroup(pid, "SIGKILL");
      }, options.graceMs),
    );
  };

  const cancel = (signal: NodeJS.Signals = "SIGINT", scope: CancelScope = "child"): void => {
    if (state.exited || state.cancelRequested) return;
    state.cancelRequested = true;
    stop(signal, scope);
  };

  const overflow = (): void => {
    state.stdoutOverflow = true;
    stdoutBuffer = "";
    killGroup(pid, "SIGKILL");
  };

  timers.push(
    setTimeout(() => {
      if (state.exited || state.cancelRequested) return;
      state.timedOut = true;
      stop("SIGINT");
    }, options.timeoutMs),
  );

  child.stdin?.on("error", () => {
    // EPIPE when the CLI exits before reading stdin; the exit code reports the failure.
  });
  child.stdin?.end(options.stdin);

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (state.stdoutOverflow) return;
    stdoutChars += chunk.length;
    if (stdoutChars > options.maxStdoutChars) {
      overflow();
      return;
    }
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      options.onStdoutLine(stdoutBuffer.slice(0, newline).replace(/\r$/, ""));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");
    }
    if (stdoutBuffer.length > options.maxLineChars) overflow();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    // Bounded: diagnostics only.
    if (stderr.length < options.maxStderrChars) {
      stderr = (stderr + chunk).slice(0, options.maxStderrChars);
    }
  });

  const exit = new Promise<ProcessExit>((resolveExit) => {
    child.once("close", (exitCode, signal) => {
      state.exited = true;
      for (const timer of timers) clearTimeout(timer);
      if (stdoutBuffer !== "" && !state.stdoutOverflow) options.onStdoutLine(stdoutBuffer);
      if (isGroupAlive(pid)) {
        state.leftoverProcessesKilled = true;
        killGroup(pid, "SIGKILL");
      }
      resolveExit({
        exitCode,
        signal,
        durationMs: performance.now() - startedAt,
        stderr,
        cancelRequested: state.cancelRequested,
        timedOut: state.timedOut,
        stdoutOverflow: state.stdoutOverflow,
        escalated: state.escalated,
        leftoverProcessesKilled: state.leftoverProcessesKilled,
      });
    });
  });

  return { pid, cancel, exit };
}
