import { startSupervisedProcess, type ProcessExit } from "./supervised-process.js";

export interface RunCommandOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export type CommandOutcome =
  { kind: "spawn-failed" } | { kind: "finished"; exit: ProcessExit; stdout: string };

const SHORT_COMMAND_LIMITS = {
  graceMs: 2000,
  maxStdoutChars: 1_000_000,
  maxLineChars: 1_000_000,
  maxStderrChars: 16_000,
} as const;

/**
 * Runs a short, non-interactive command (version, status) to completion with the same process
 * handling as a worker run. Never throws for a missing executable: that is `spawn-failed`.
 */
export async function runCommand(options: RunCommandOptions): Promise<CommandOutcome> {
  const lines: string[] = [];
  let supervised;
  try {
    supervised = await startSupervisedProcess({
      ...options,
      ...SHORT_COMMAND_LIMITS,
      stdin: "",
      onStdoutLine: (line) => lines.push(line),
    });
  } catch {
    return { kind: "spawn-failed" };
  }
  const exit = await supervised.exit;
  return { kind: "finished", exit, stdout: lines.join("\n") };
}
