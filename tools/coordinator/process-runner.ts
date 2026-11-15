// The only place in tools/coordinator that starts processes. Everything is argv-based
// (`spawn` with `shell: false`); the single exception is the WSL step, which hands one
// `bash -lc` payload to wsl.exe (or to bash directly when already inside Linux). Tests inject a
// fake Runner instead.
import "../register-ts-imports.ts";
const { loadOmiSetting } = await import("../../src/infrastructure/config/load-omisetting.ts");
const { assertKnownCredentialFree } =
  await import("../../src/application/contracts/credential-input.ts");
const { dockerExecCommand } = await import("../../src/infrastructure/processes/docker-runtime.ts");
import { spawn } from "node:child_process";
import type { CoordinatorTarget } from "./coordinator-settings.ts";

export interface Command {
  readonly file: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly keepStdinOpen?: boolean;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Written to stdin (e.g. GraphQL request JSON, a comment body). */
  readonly input?: string;
  readonly timeoutMs?: number;
  /** Cancels in-flight watch reads when the terminal closes. */
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Runner = (command: Command) => Promise<RunResult>;

/** A process that could not start (e.g. wsl.exe missing) resolves with code 127, never throws. */
export function createProcessRunner(): Runner {
  return async (original) => {
    let command = original;
    if (
      command.file === "docker" &&
      command.args[0] === "exec" &&
      command.env?.GH_TOKEN === undefined
    ) {
      const settings = await loadOmiSetting(process.cwd());
      if (settings?.docker !== undefined) {
        command = {
          ...command,
          args: ["exec", "-e", "GH_TOKEN", ...command.args.slice(1)],
          env: { ...command.env, GH_TOKEN: settings.github.token },
        };
      }
    }
    return new Promise((resolve) => {
      const child = spawn(command.file, [...command.args], {
        cwd: command.cwd,
        env: { ...process.env, ...command.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        signal: command.signal,
        timeout: command.timeoutMs ?? 120_000,
      });
      let stdout = "";
      let stderr = "";
      const heartbeat = command.keepStdinOpen
        ? setInterval(() => {
            if (child.stdin.writable && child.stdin.writableLength === 0)
              child.stdin.write("heartbeat\n");
          }, 5000)
        : undefined;
      let settled = false;
      const finish = (result: RunResult) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        const sensitiveValues = Object.entries(command.env ?? {})
          .filter(([name]) => name === "GH_TOKEN" || name === "CLAUDE_CODE_OAUTH_TOKEN")
          .map(([, value]) => value);
        try {
          assertKnownCredentialFree([result.stdout, result.stderr], { sensitiveValues });
          resolve(result);
        } catch {
          resolve({ code: 1, stdout: "", stderr: "Process output refused: credential material" });
        }
      };
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", (error) => {
        finish({ code: 127, stdout, stderr: `${stderr}${error.message}` });
      });
      child.on("close", (code, signal) => {
        finish({ code: code ?? (signal ? 128 : 1), stdout, stderr });
      });
      child.stdin.on("error", () => undefined);
      if (command.keepStdinOpen) child.stdin.write(command.input ?? "");
      else child.stdin.end(command.input ?? "");
    });
  };
}

const SAFE_WORD = /^[A-Za-z0-9_/.:=@%+,-]+$/;

/** POSIX single-quote quoting for one argument of the bash payload. */
export function shellQuote(arg: string): string {
  if (SAFE_WORD.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Joins argv steps into one `&&` chain; each argument is quoted on its own. */
export function joinSteps(steps: readonly (readonly string[])[]): string {
  return steps.map((argv) => argv.map(shellQuote).join(" ")).join(" && ");
}

// Windows passes wsl.exe one command-line string and rewrites `"` and `\` while quoting it, so
// the payload must not contain them. Inputs that would need them are rejected before this point.
const WINDOWS_UNSAFE = /["\\\r\n]/;

/** A non-interactive `bash -lc` in WSL only gets node/npm/claude/codex on PATH from nvm. */
export const WSL_NODE_ENV = "[ -s $HOME/.nvm/nvm.sh ] && . $HOME/.nvm/nvm.sh >/dev/null 2>&1;";

/** Runs a bash payload in the WSL checkout. */
export function wslCommand(
  payload: string,
  target: CoordinatorTarget,
  timeoutMs?: number,
): Command {
  if (target.kind === "docker") {
    return {
      ...dockerExecCommand(target, payload.replaceAll(WSL_NODE_ENV, "")),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  if (WINDOWS_UNSAFE.test(payload)) {
    throw new Error(`WSL payload must not contain double quotes, backslashes or newlines`);
  }
  const extra = timeoutMs === undefined ? {} : { timeoutMs };
  return target.viaWslExe
    ? {
        file: "wsl.exe",
        args: ["-d", target.distro, "--cd", target.repoDir, "--exec", "bash", "-lc", payload],
        ...extra,
      }
    : { file: "bash", args: ["-lc", payload], cwd: target.repoDir, ...extra };
}

/** Human-readable form used by --dry-run; quoting is for display only. */
export function formatCommand(command: Command): string {
  const line = [command.file, ...command.args].map(shellQuote).join(" ");
  const notes = [
    command.cwd === undefined ? "" : ` (cwd ${command.cwd})`,
    command.input === undefined ? "" : ` (stdin: ${String(command.input.length)} chars)`,
  ];
  return line + notes.join("");
}

/** Runs and returns stdout, throwing with stderr on a non-zero exit. */
export async function runChecked(runner: Runner, command: Command): Promise<string> {
  const result = await runner(command);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${command.file} exited ${String(result.code)}: ${detail.slice(0, 500)}`);
  }
  return result.stdout;
}

export { dockerExecCommand };
