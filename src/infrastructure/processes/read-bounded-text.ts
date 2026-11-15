import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Reads only a bounded regular UTF-8 file, without following a symlink or echoing its bytes. */
export async function readBoundedText(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) return undefined;
      const buffer = Buffer.alloc(maxBytes + 1);
      let offset = 0;
      for (;;) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
        offset += bytesRead;
        if (offset > maxBytes) return undefined;
        if (bytesRead === 0) break;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}
