import type { CheckRunRecord } from "../../application/contracts/check-run.js";
import type { ArtifactStore } from "../../application/ports/artifact-store.js";
import type { CheckRunner, CheckRunRequest } from "../../application/ports/check-runner.js";
import { gitCommand } from "../git/git-command.js";
import { redactDiagnostic } from "./redact-diagnostic.js";
import { startSupervisedProcess, type ProcessExit } from "./supervised-process.js";

export interface ConfiguredCheck {
  /** Executable and arguments. Run without a shell. */
  readonly command: readonly string[];
  readonly timeoutMs: number;
}

export interface ProcessCheckRunnerOptions {
  readonly checks: Readonly<Record<string, ConfiguredCheck>>;
  readonly artifacts: ArtifactStore;
  readonly now: () => number;
  readonly nextId: () => string;
}

/** The stored log keeps the end of the output, where a failing check says why. */
const MAX_LOG_CHARS = 16_000;
const KEPT_TAIL_CHARS = 64_000;

/** Not the runtime's own environment: only what a build tool needs to find itself. */
function checkEnvironment(): Record<string, string> {
  const names = ["PATH", "HOME", "LANG", "TMPDIR"];
  const env: Record<string, string> = { CI: "true" };
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Runs each configured check's command as a child process in the attempt's worktree. */
export function createProcessCheckRunner(options: ProcessCheckRunnerOptions): CheckRunner {
  const timestamp = () => new Date(options.now()).toISOString();

  return {
    has: (checkId) => Object.hasOwn(options.checks, checkId),

    async run(request: CheckRunRequest): Promise<CheckRunRecord> {
      const check = Object.hasOwn(options.checks, request.checkId)
        ? options.checks[request.checkId]
        : undefined;
      if (check === undefined) throw new Error("CHECK_UNKNOWN");
      const [executable, ...args] = check.command;
      if (executable === undefined) throw new Error("CHECK_UNKNOWN");

      const revision = gitCommand(request.workspacePath, ["rev-parse", "HEAD"]).stdout.trim();
      const startedAt = timestamp();
      const lines: string[] = [];
      let kept = 0;
      let exit: ProcessExit | undefined;
      try {
        const supervised = await startSupervisedProcess({
          executable,
          args,
          cwd: request.workspacePath,
          env: checkEnvironment(),
          stdin: "",
          timeoutMs: check.timeoutMs,
          graceMs: 2000,
          maxStdoutChars: 64_000_000,
          maxLineChars: 1_000_000,
          maxStderrChars: KEPT_TAIL_CHARS,
          onStdoutLine: (line) => {
            lines.push(line);
            kept += line.length + 1;
            while (kept > KEPT_TAIL_CHARS && lines.length > 1)
              kept -= (lines.shift()?.length ?? 0) + 1;
          },
        });
        exit = await supervised.exit;
      } catch {
        exit = undefined; // the command could not start
      }
      const endedAt = timestamp();

      const status =
        exit === undefined
          ? "failed"
          : exit.timedOut
            ? "timed-out"
            : exit.exitCode === 0 && !exit.stdoutOverflow
              ? "passed"
              : "failed";
      const exitCode = exit?.exitCode ?? null;
      const raw = [...lines, exit?.stderr ?? ""].join("\n");
      const log = redactDiagnostic(raw, raw.length).slice(-MAX_LOG_CHARS);
      const evidence = options.artifacts.write({
        id: options.nextId(),
        path: `${request.artifactRoot}/checks/${request.checkId}.json`,
        bytes: new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            checkId: request.checkId,
            command: check.command,
            exitCode,
            status,
            startedAt,
            endedAt,
            revision,
            log,
          }),
        ),
        producerAttemptId: request.attemptId,
        classification: "check-evidence",
        createdAt: endedAt,
      });
      return {
        checkId: request.checkId,
        status,
        exitCode,
        command: [...check.command],
        startedAt,
        endedAt,
        revision,
        evidence,
      };
    },
  };
}
