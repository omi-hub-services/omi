import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { TransportError } from "./github-transport.js";
import type { GithubTransport, HttpRequest, HttpResponse } from "./github-transport.js";

/** What running `gh` produced. `timedOut` is set when the process was killed for taking too long. */
export interface GhRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export type GhRunner = (
  args: readonly string[],
  stdin: string | undefined,
  timeoutMs: number,
) => Promise<GhRunResult>;

export interface GhApiTransportOptions {
  readonly run?: GhRunner;
  readonly timeoutMs?: number;
}

export const DEFAULT_GH_TIMEOUT_MS = 30_000;

/** `gh` exits with 4 when it has no usable login. */
const GH_EXIT_AUTH_REQUIRED = 4;
/** Reported by `execFile` when the executable is missing. */
const EXIT_NOT_FOUND = 127;

/**
 * GitHub transport over the authenticated `gh` CLI (architecture.md §11): argv and stdin only, no
 * shell, and no token ever enters this process or a command line, because `gh` owns the login.
 *
 * `gh api --include` prints the status line and headers before the body, also for error statuses
 * (where it additionally exits non-zero). The parse below therefore trusts the printed response
 * over the exit code, and treats output without a status line as "no response arrived".
 */
export function createGhApiTransport(options: GhApiTransportOptions = {}): GithubTransport {
  const run = options.run ?? runGh;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      const args = ["api", "--include", "-X", request.method, request.path];
      const stdin = request.body === undefined ? undefined : JSON.stringify(request.body);
      if (stdin !== undefined) args.push("--input", "-");

      const result = await run(args, stdin, timeoutMs);
      const parsed = parseGhApiOutput(result.stdout);
      if (parsed !== undefined && !result.timedOut) return parsed;
      if (result.timedOut) throw new TransportError("timeout");
      if (result.code === EXIT_NOT_FOUND) throw new TransportError("not_installed");
      if (result.code === GH_EXIT_AUTH_REQUIRED) throw new TransportError("auth_required");
      throw new TransportError("connection");
    },
  };
}

const STATUS_LINE = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/;

/**
 * Parses `gh api --include` output: status line, header lines, a blank line, then the body.
 * Returns `undefined` when the output does not start with a status line.
 */
export function parseGhApiOutput(output: string): HttpResponse | undefined {
  const separator = /\r?\n\r?\n/.exec(output);
  const head = separator === null ? output : output.slice(0, separator.index);
  const body = separator === null ? "" : output.slice(separator.index + separator[0].length);
  const [statusLine = "", ...headerLines] = head.split(/\r?\n/);
  const status = STATUS_LINE.exec(statusLine)?.[1];
  if (status === undefined) return undefined;

  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // Repeated headers are joined the way HTTP defines it.
    headers[name] = name in headers ? `${headers[name] ?? ""}, ${value}` : value;
  }
  return { status: Number(status), headers, body };
}

/** Runs `gh` without a shell, in a temp cwd so no local checkout is mistaken for the target repo. */
export function runGh(
  args: readonly string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<GhRunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "gh",
      [...args],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "", NO_COLOR: "1" },
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ code: 0, stdout, timedOut: false });
          return;
        }
        const timedOut = error.killed === true && error.signal === "SIGTERM";
        const code =
          typeof error.code === "number"
            ? error.code
            : error.code === "ENOENT"
              ? EXIT_NOT_FOUND
              : 1;
        resolve({ code, stdout, timedOut });
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin ?? "");
  });
}
