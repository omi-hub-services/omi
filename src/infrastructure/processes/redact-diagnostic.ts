/**
 * Best-effort scrubbing of CLI error text before it is stored or shown (tech-stack.md §9).
 * Regexes cannot catch every secret, so callers also keep only short, bounded excerpts and
 * never store raw output streams.
 */
export function redactDiagnostic(text: string, maxChars: number): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[REDACTED_LONG_TOKEN]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}
