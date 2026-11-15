import { z } from "zod";
import type { Command } from "../../application/contracts/command.js";

/**
 * Local IPC protocol between the CLI and the runtime (tech-stack.md §7, ADR-0020).
 *
 * Transport: Unix domain socket. Framing: a 4-byte big-endian unsigned payload length, then that
 * many bytes of UTF-8 JSON. One request frame gets exactly one response frame, in order.
 * Changing a field of this protocol means a new `PROTOCOL_VERSION`, not an edit.
 */
export const PROTOCOL_VERSION = 1;

/** Hard limit on one frame payload, both directions. A larger length header is rejected unread. */
export const MAX_PAYLOAD_BYTES = 1_048_576;

/** Bytes of the length prefix. */
export const FRAME_HEADER_BYTES = 4;

/** Codes the runtime puts in an error response. */
export const SERVER_ERROR_CODES = [
  "PAYLOAD_TOO_LARGE",
  "MALFORMED_REQUEST",
  "UNSUPPORTED_VERSION",
  "INVALID_COMMAND",
  "NOT_IMPLEMENTED",
  "INTERNAL_ERROR",
  "APPROVAL_REFUSED",
  "COMMAND_REFUSED",
] as const;

/** Codes only the client produces: no usable response arrived. */
export const CLIENT_ERROR_CODES = ["RUNTIME_UNAVAILABLE", "TIMEOUT", "PROTOCOL_ERROR"] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];
export type IpcErrorCode = ServerErrorCode | (typeof CLIENT_ERROR_CODES)[number];

export interface IpcError {
  readonly code: IpcErrorCode;
  readonly message: string;
}

export const requestIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

/**
 * The request envelope. `command` stays unvalidated here so the server can tell a broken
 * envelope (MALFORMED_REQUEST) from a well-formed envelope carrying a bad command
 * (INVALID_COMMAND); the server validates it with the v1 contract next.
 */
export const requestEnvelopeSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: requestIdSchema,
  command: z.unknown(),
});
export interface IpcRequest {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly command: Command;
}

const errorBody = z.strictObject({
  code: z.enum([...SERVER_ERROR_CODES, ...CLIENT_ERROR_CODES]),
  message: z.string().max(1000),
});

/** `requestId` is null only when the request was too broken to read one. */
export const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema.nullable(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema.nullable(),
    ok: z.literal(false),
    error: errorBody,
  }),
]);
export type IpcResponse = z.infer<typeof responseSchema>;

/** What a caller of the client gets back: the result, or a typed error. Never a thrown error. */
export type IpcOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: IpcError };

/**
 * What a command handler returns; the server turns it into a response frame. A handler can only
 * use server codes: client codes describe failures to get a response at all.
 */
export type HandlerOutcome =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly code: ServerErrorCode; readonly message: string };
    };
export type CommandHandler = (command: Command) => Promise<HandlerOutcome>;
