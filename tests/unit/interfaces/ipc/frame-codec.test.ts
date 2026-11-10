import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "../../../../src/interfaces/ipc/frame-codec.js";

describe("frame codec", () => {
  it("prefixes the payload with its big-endian byte length (not character count)", () => {
    const frame = encodeFrame("héllo");
    expect(frame.readUInt32BE(0)).toBe(Buffer.byteLength("héllo"));
    expect(frame.subarray(4).toString("utf8")).toBe("héllo");
  });

  it("refuses to encode a payload over the limit", () => {
    expect(() => encodeFrame("x".repeat(11), 10)).toThrow(RangeError);
  });

  it("reassembles a frame split at every byte boundary", () => {
    const frame = encodeFrame('{"a":1}');
    const decoder = new FrameDecoder();
    const events = [...frame].flatMap((byte) => decoder.push(Buffer.from([byte])));
    expect(events).toEqual([{ kind: "frame", payload: '{"a":1}' }]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("splits several frames that arrive in one chunk", () => {
    const decoder = new FrameDecoder();
    const events = decoder.push(Buffer.concat([encodeFrame("one"), encodeFrame("two")]));
    expect(events.map((e) => (e.kind === "frame" ? e.payload : e.kind))).toEqual(["one", "two"]);
  });

  it("rejects an oversized header without waiting for the payload, then ignores input", () => {
    const decoder = new FrameDecoder(16);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(17, 0);
    expect(decoder.push(header)).toEqual([{ kind: "oversized", declaredBytes: 17 }]);
    expect(decoder.isFailed).toBe(true);
    expect(decoder.push(encodeFrame("ok"))).toEqual([]);
  });

  it("accepts a payload of exactly the limit", () => {
    const decoder = new FrameDecoder(8);
    expect(decoder.push(encodeFrame("12345678", 8))).toEqual([
      { kind: "frame", payload: "12345678" },
    ]);
  });

  it("reports invalid UTF-8 and stays aligned for the next frame", () => {
    const bad = Buffer.from([0, 0, 0, 2, 0xff, 0xfe]);
    const decoder = new FrameDecoder();
    const events = decoder.push(Buffer.concat([bad, encodeFrame("fine")]));
    expect(events).toEqual([{ kind: "invalid-utf8" }, { kind: "frame", payload: "fine" }]);
  });

  it("exposes bytes of an unfinished frame", () => {
    const decoder = new FrameDecoder();
    decoder.push(encodeFrame("abcdef").subarray(0, 6));
    expect(decoder.bufferedBytes).toBe(6);
  });
});
