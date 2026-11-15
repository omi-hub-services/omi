import { appendFile, chmod, lstat, mkdir, stat, unlink } from "node:fs/promises";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { dirname } from "node:path";
import type { ZodError } from "zod";
import { commandSchema } from "../../application/contracts/command.js";
import { encodeFrame, FrameDecoder } from "./frame-codec.js";
import type { FrameEvent } from "./frame-codec.js";
import { MAX_PAYLOAD_BYTES, PROTOCOL_VERSION, requestEnvelopeSchema } from "./protocol.js";
import type { CommandHandler, IpcResponse, ServerErrorCode } from "./protocol.js";

export interface IpcServerOptions {
  readonly socketPath: string;
  readonly handler: CommandHandler;
  readonly maxPayloadBytes?: number;
  /** A connection with no traffic for this long is destroyed (stalled or half-sent frame). */
  readonly idleTimeoutMs?: number;
  readonly maxConnections?: number;
  /** Runtime-local file that receives unexpected handler errors; never sent to the client. */
  readonly errorLogPath?: string;
}

export interface IpcServer {
  /** Binds the socket (directory 0700, socket 0600). Rejects if it cannot do so safely. */
  start(): Promise<void>;
  /** Closes the listener and every open connection; the socket file is removed. */
  stop(): Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 32;
// sun_path is 108 bytes on Linux; stay below it with room for the NUL.
const MAX_SOCKET_PATH_BYTES = 104;
const OVERSIZED_CLOSE_GRACE_MS = 1_000;

function failure(requestId: string | null, code: ServerErrorCode, message: string): IpcResponse {
  return { protocolVersion: PROTOCOL_VERSION, requestId, ok: false, error: { code, message } };
}

/** Short, bounded description of why a payload failed validation (never the payload itself). */
function describeIssues(error: ZodError): string {
  const text = error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SECRET_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b|(?:Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

/** Appends the cause to the runtime-local log; a failure to log never changes the reply. */
async function logHandlerError(path: string | undefined, error: unknown): Promise<void> {
  if (path === undefined) return;
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(
      path,
      `${new Date().toISOString()} ${text.replace(SECRET_PATTERN, "[redacted]")}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Logging is best effort.
  }
}

/** Turns one request payload into exactly one response. Never throws. */
async function respondTo(
  payload: string,
  handler: CommandHandler,
  errorLogPath: string | undefined,
): Promise<IpcResponse> {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return failure(null, "MALFORMED_REQUEST", "request payload is not valid JSON");
  }
  if (!isRecord(raw)) {
    return failure(null, "MALFORMED_REQUEST", "request payload must be a JSON object");
  }
  const idCheck = requestEnvelopeSchema.shape.requestId.safeParse(raw["requestId"]);
  const requestId = idCheck.success ? idCheck.data : null;

  const version = raw["protocolVersion"];
  if (typeof version !== "number") {
    return failure(requestId, "MALFORMED_REQUEST", "protocolVersion must be a number");
  }
  if (version !== PROTOCOL_VERSION) {
    return failure(
      requestId,
      "UNSUPPORTED_VERSION",
      `protocol version ${String(version)} is not supported; supported: ${String(PROTOCOL_VERSION)}`,
    );
  }
  const envelope = requestEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return failure(requestId, "MALFORMED_REQUEST", describeIssues(envelope.error));
  }
  const command = commandSchema.safeParse(envelope.data.command);
  if (!command.success) {
    return failure(envelope.data.requestId, "INVALID_COMMAND", describeIssues(command.error));
  }

  try {
    const outcome = await handler(command.data);
    if (outcome.ok) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId: envelope.data.requestId,
        ok: true,
        result: outcome.result,
      };
    }
    // A handler may only report codes the server owns; client-side codes cannot come from here.
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId: envelope.data.requestId,
      ok: false,
      error: outcome.error,
    };
  } catch (error) {
    // The cause may hold paths or SQL; the caller gets a fixed message, the operator a local log.
    await logHandlerError(errorLogPath, error);
    return failure(
      envelope.data.requestId,
      "INTERNAL_ERROR",
      "the runtime failed to handle the command",
    );
  }
}

function writeFrame(socket: Socket, frame: Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed || !socket.writable) {
      resolve();
      return;
    }
    // The callback fires once the data is flushed (backpressure) or the write failed.
    socket.write(frame, () => {
      resolve();
    });
  });
}

function encodeResponse(response: IpcResponse, maxPayloadBytes: number): Buffer {
  try {
    return encodeFrame(JSON.stringify(response), maxPayloadBytes);
  } catch {
    return encodeFrame(
      JSON.stringify(
        failure(response.requestId, "INTERNAL_ERROR", "the response exceeds the payload limit"),
      ),
      maxPayloadBytes,
    );
  }
}

export function createIpcServer(options: IpcServerOptions): IpcServer {
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const sockets = new Set<Socket>();

  function onConnection(socket: Socket): void {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // A peer that resets the connection must not surface as an uncaught exception.
    socket.on("error", () => {
      socket.destroy();
    });
    socket.setTimeout(idleTimeoutMs, () => {
      socket.destroy();
    });

    const decoder = new FrameDecoder(maxPayloadBytes);
    const queue: FrameEvent[] = [];
    let draining = false;
    let closing = false;

    async function drain(): Promise<void> {
      if (draining) return;
      draining = true;
      // One request at a time per connection: a pipelining client cannot grow memory unboundedly.
      socket.pause();
      // A handler awaiting a bounded PO confirmation is active work, not an idle peer.
      socket.setTimeout(0);
      try {
        for (let event = queue.shift(); event !== undefined; event = queue.shift()) {
          let response: IpcResponse;
          if (event.kind === "frame") {
            response = await respondTo(event.payload, options.handler, options.errorLogPath);
          } else if (event.kind === "oversized") {
            response = failure(
              null,
              "PAYLOAD_TOO_LARGE",
              `frame of ${String(event.declaredBytes)} bytes exceeds the ${String(maxPayloadBytes)}-byte limit`,
            );
            // The stream cannot be re-aligned after an untrusted length: answer, then close.
            closing = true;
          } else {
            response = failure(null, "MALFORMED_REQUEST", "request payload is not valid UTF-8");
          }
          await writeFrame(socket, encodeResponse(response, maxPayloadBytes));
          if (closing) break;
        }
      } finally {
        draining = false;
        if (closing) {
          queue.length = 0;
          socket.end();
          // Keep reading (and discarding) so closing does not reset the connection under our reply.
          socket.resume();
          setTimeout(() => {
            socket.destroy();
          }, OVERSIZED_CLOSE_GRACE_MS).unref();
        } else if (!socket.destroyed) {
          socket.setTimeout(idleTimeoutMs);
          socket.resume();
        }
      }
    }

    socket.on("data", (chunk: Buffer) => {
      if (closing) return;
      queue.push(...decoder.push(chunk));
      void drain();
    });
  }

  const server: Server = createServer(onConnection);
  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

  return {
    async start(): Promise<void> {
      await prepareSocketDirectory(options.socketPath);
      await removeStaleSocket(options.socketPath);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      // The directory is already 0700, so no other user could connect in this window.
      await chmod(options.socketPath, 0o600);
    },
    async stop(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** The socket lives in a directory only its owner can enter; we never loosen an existing one. */
async function prepareSocketDirectory(socketPath: string): Promise<void> {
  if (Buffer.byteLength(socketPath) >= MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `socket path is too long for a Unix socket (limit ${String(MAX_SOCKET_PATH_BYTES)} bytes)`,
    );
  }
  const dir = dirname(socketPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await stat(dir);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`socket directory ${dir} is not owned by the current user`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `socket directory ${dir} must not be accessible to group or others (mode 0700)`,
    );
  }
}

/** Removes a leftover socket file only when nothing answers on it. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  const info = await lstat(socketPath).catch(() => undefined);
  if (info === undefined) return;
  if (!info.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
  const code = await new Promise<string>((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve("LISTENING");
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? "UNKNOWN");
    });
  });
  if (code === "LISTENING")
    throw new Error(`another runtime is already listening on ${socketPath}`);
  if (code !== "ECONNREFUSED" && code !== "ENOENT") {
    throw new Error(`cannot tell whether ${socketPath} is in use (${code})`);
  }
  await unlink(socketPath).catch(() => undefined);
}
