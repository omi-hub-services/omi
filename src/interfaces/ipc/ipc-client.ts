import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import type { Command } from "../../application/contracts/command.js";
import { encodeFrame, FrameDecoder } from "./frame-codec.js";
import { MAX_PAYLOAD_BYTES, PROTOCOL_VERSION, responseSchema } from "./protocol.js";
import type { IpcError, IpcOutcome } from "./protocol.js";

export interface SendCommandOptions {
  readonly socketPath: string;
  readonly command: Command;
  /** Overall deadline for connect + request + response. */
  readonly timeoutMs?: number;
  /** Fixed id for tests; defaults to a random UUID. */
  readonly requestId?: string;
  readonly maxPayloadBytes?: number;
}

export type SendCommand = (options: SendCommandOptions) => Promise<IpcOutcome>;

const DEFAULT_TIMEOUT_MS = 5_000;
// Errors that mean "no runtime is listening there" rather than a broken exchange.
const UNAVAILABLE_CODES = new Set(["ENOENT", "ECONNREFUSED", "EACCES", "EPERM", "ENOTSOCK"]);

const failed = (error: IpcError): IpcOutcome => ({ ok: false, error });

/**
 * Sends one command over the socket and resolves with the runtime's answer or a typed client
 * error. It never rejects: every transport failure is an `IpcOutcome` the CLI can map to an exit
 * code. The response must echo our request id and use our protocol version.
 */
export const sendCommand: SendCommand = (options) =>
  new Promise<IpcOutcome>((resolve) => {
    const maxPayloadBytes = options.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
    const requestId = options.requestId ?? randomUUID();
    let settled = false;
    const finish = (outcome: IpcOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };

    const socket = connect(options.socketPath);
    const timer = setTimeout(() => {
      finish(failed({ code: "TIMEOUT", message: "the runtime did not answer in time" }));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const decoder = new FrameDecoder(maxPayloadBytes);

    socket.once("connect", () => {
      try {
        socket.write(
          encodeFrame(
            JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              requestId,
              command: options.command,
            }),
            maxPayloadBytes,
          ),
        );
      } catch {
        finish(
          failed({ code: "PROTOCOL_ERROR", message: "the request exceeds the payload limit" }),
        );
      }
    });

    socket.on("data", (chunk: Buffer) => {
      for (const event of decoder.push(chunk)) {
        if (event.kind !== "frame") {
          finish(failed({ code: "PROTOCOL_ERROR", message: "the runtime sent an invalid frame" }));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.payload);
        } catch {
          finish(failed({ code: "PROTOCOL_ERROR", message: "the runtime sent invalid JSON" }));
          return;
        }
        const response = responseSchema.safeParse(parsed);
        if (!response.success) {
          finish(
            failed({
              code: "PROTOCOL_ERROR",
              message: "the runtime sent an unknown response shape",
            }),
          );
          return;
        }
        const body = response.data;
        // A null id is legitimate only on an error: the server could not read our id back.
        if (body.requestId !== requestId && !(body.requestId === null && !body.ok)) {
          finish(
            failed({
              code: "PROTOCOL_ERROR",
              message: "the response does not match the request id",
            }),
          );
          return;
        }
        finish(body.ok ? { ok: true, result: body.result } : { ok: false, error: body.error });
        return;
      }
    });

    socket.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code ?? "";
      finish(
        UNAVAILABLE_CODES.has(code)
          ? failed({
              code: "RUNTIME_UNAVAILABLE",
              message: `no runtime is listening on ${options.socketPath} (${code})`,
            })
          : failed({ code: "PROTOCOL_ERROR", message: `connection failed (${code || "unknown"})` }),
      );
    });

    socket.on("close", () => {
      finish(
        failed({
          code: "PROTOCOL_ERROR",
          message: "the runtime closed the connection without answering",
        }),
      );
    });
  });
