import type { QuotaReader } from "../../application/ports/quota-reader.js";

/** One reader per tool; the profile's own `tool` decides which one reads it. */
export function createProfileQuotaReader(
  readers: Readonly<Record<"claude-code" | "codex", QuotaReader>>,
): QuotaReader {
  return { read: (profile, options) => readers[profile.tool].read(profile, options) };
}
