import { FRAME_HEADER_BYTES, MAX_PAYLOAD_BYTES } from "./protocol.js";

export function encodeFrame(payload: string, maxPayloadBytes = MAX_PAYLOAD_BYTES): Buffer {
  const body = Buffer.from(payload, "utf8");
  if (body.length > maxPayloadBytes) {
    throw new RangeError(`frame payload of ${String(body.length)} bytes exceeds the limit`);
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export type FrameEvent =
  | { readonly kind: "frame"; readonly payload: string }
  | { readonly kind: "oversized"; readonly declaredBytes: number }
  | { readonly kind: "invalid-utf8" };

/**
 * Incremental decoder for one byte stream. It never buffers more than `maxPayloadBytes` plus a
 * header: an oversized length header ends decoding at once, without reading the payload, because
 * the stream can no longer be trusted to be aligned on a frame boundary.
 */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private failed = false;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });

  private readonly maxPayloadBytes: number;

  constructor(maxPayloadBytes = MAX_PAYLOAD_BYTES) {
    this.maxPayloadBytes = maxPayloadBytes;
  }

  /** True once an oversized header was seen; further input is ignored. */
  get isFailed(): boolean {
    return this.failed;
  }

  push(chunk: Buffer): FrameEvent[] {
    if (this.failed) return [];
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const events: FrameEvent[] = [];
    while (this.pending.length >= FRAME_HEADER_BYTES) {
      const length = this.pending.readUInt32BE(0);
      if (length > this.maxPayloadBytes) {
        this.failed = true;
        this.pending = Buffer.alloc(0);
        events.push({ kind: "oversized", declaredBytes: length });
        return events;
      }
      if (this.pending.length < FRAME_HEADER_BYTES + length) break;
      const body = this.pending.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length);
      this.pending = this.pending.subarray(FRAME_HEADER_BYTES + length);
      try {
        events.push({ kind: "frame", payload: this.utf8.decode(body) });
      } catch {
        events.push({ kind: "invalid-utf8" });
      }
    }
    return events;
  }

  /** Bytes of an unfinished frame; non-zero when the peer hung up mid-frame. */
  get bufferedBytes(): number {
    return this.pending.length;
  }
}
