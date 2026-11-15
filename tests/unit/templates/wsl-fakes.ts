import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { BridgeSpawn } from "../../../templates/bridges/claude-code/omi-squad/bridge.ts";

/**
 * Reference parser for the Windows command-line rules wsl.exe's C runtime applies
 * (`CommandLineToArgvW` for arguments after the program name): 2n backslashes before a quote
 * give n backslashes and toggle quoting, 2n+1 give n backslashes and a literal quote, other
 * backslashes are literal, and whitespace outside quotes separates arguments.
 */
export function parseWindowsCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (char === "\\") {
      let count = 0;
      while (line.charAt(index) === "\\") {
        count += 1;
        index += 1;
      }
      if (line.charAt(index) === '"') {
        current += "\\".repeat(Math.floor(count / 2));
        started = true;
        if (count % 2 === 1) {
          current += '"';
        } else {
          inQuotes = !inQuotes;
        }
      } else {
        current += "\\".repeat(count);
        started = true;
        index -= 1;
      }
    } else if (char === '"') {
      inQuotes = !inQuotes;
      started = true;
    } else if ((char === " " || char === "\t") && !inQuotes) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

export interface WslCall {
  readonly distribution: string;
  readonly repository: string;
  readonly shim: string;
  readonly cliArgs: string[];
  readonly stdin: string;
}

export interface WslAnswer {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

/**
 * Stands in for `wsl.exe`: reconstructs the argument vector wsl.exe would hand to the shim (from
 * the single Windows command line, or from the array on other platforms), records it, and lets
 * the test answer like the CLI would. It never starts a process.
 */
export function createFakeWsl(answer: (call: WslCall) => Promise<WslAnswer>): {
  readonly spawn: BridgeSpawn;
  readonly calls: WslCall[];
  readonly executables: string[];
  readonly options: unknown[];
} {
  const calls: WslCall[] = [];
  const executables: string[] = [];
  const options: unknown[] = [];
  const spawn: BridgeSpawn = (executable, args, spawnOptions) => {
    executables.push(executable);
    options.push(spawnOptions);
    const argv =
      spawnOptions.windowsVerbatimArguments === true
        ? parseWindowsCommandLine(args.join(" "))
        : [...args];
    const input: Buffer[] = [];
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: Writable;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        input.push(chunk);
        callback();
      },
      final(callback) {
        const [dashD, distribution, dashCd, repository, dashExec, shim, ...cliArgs] = argv;
        if (dashD !== "-d" || dashCd !== "--cd" || dashExec !== "--exec") {
          throw new Error(`unexpected wsl.exe arguments: ${JSON.stringify(argv)}`);
        }
        const call: WslCall = {
          distribution: distribution ?? "",
          repository: repository ?? "",
          shim: shim ?? "",
          cliArgs,
          stdin: Buffer.concat(input).toString("utf8"),
        };
        calls.push(call);
        void answer(call).then((result) => {
          child.stdout.end(result.stdout);
          child.stderr.end(result.stderr ?? "");
          child.emit("close", result.exitCode);
          callback();
        });
      },
    });
    return child as unknown as ChildProcess;
  };
  return { spawn, calls, executables, options };
}
