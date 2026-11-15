/** Largest text a CLI command takes on stdin; larger input is rejected, never truncated. */
export const MAX_STDIN_BYTES = 65_536;

/**
 * Reads all of a stream as strict UTF-8 text. Returns `undefined` when the text is not valid
 * UTF-8 or is larger than `maxBytes`, so callers never act on a partial or garbled value.
 */
export async function readStandardInput(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number = MAX_STDIN_BYTES,
): Promise<string | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maxBytes) return undefined;
    chunks.push(chunk);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return undefined;
  }
}
