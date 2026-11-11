export type VersionCompatibility = "supported" | "unsupported" | "unknown";

interface Version {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Supported Claude Code versions: `>=2.1.322 <2.2.0` (ADR-0023).
 *
 * 2.1.322 is the version the OMI-002 live run proved (ADR-0013). Patch releases of the same
 * minor are accepted because stream-json field names were stable across them in practice, but
 * that is an assumption: the fixtures under `tests/fixtures/executors/claude-code/` and the live
 * test must be re-run on each CLI upgrade, and this range widened only after that.
 */
export const SUPPORTED_CLAUDE_CODE_RANGE = {
  min: { major: 2, minor: 1, patch: 322 },
  maxExclusive: { major: 2, minor: 2, patch: 0 },
  description: ">=2.1.322 <2.2.0",
} as const;

/** Reads `2.1.322 (Claude Code)`-style `claude --version` output. */
export function parseClaudeCodeVersion(output: string): (Version & { text: string }) | undefined {
  const firstLine = output.trim().split(/\r?\n/, 1)[0] ?? "";
  const match = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:\s|$)/.exec(firstLine);
  if (match === null) return undefined;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    text: `${major}.${minor}.${patch}`,
  };
}

function compare(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function checkClaudeCodeVersion(output: string): {
  version: string | undefined;
  compatibility: VersionCompatibility;
} {
  const parsed = parseClaudeCodeVersion(output);
  if (parsed === undefined) return { version: undefined, compatibility: "unknown" };
  const inRange =
    compare(parsed, SUPPORTED_CLAUDE_CODE_RANGE.min) >= 0 &&
    compare(parsed, SUPPORTED_CLAUDE_CODE_RANGE.maxExclusive) < 0;
  return { version: parsed.text, compatibility: inRange ? "supported" : "unsupported" };
}
