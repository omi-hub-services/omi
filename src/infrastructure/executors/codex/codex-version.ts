/** Only the ADR-0021 live-tested CLI is supported. Widen after a fresh live capture. */
export const SUPPORTED_CODEX_RANGE = {
  min: { major: 0, minor: 167, patch: 0 },
  description: ">=0.167.0 <0.167.1",
} as const;

export function checkCodexVersion(output: string): {
  version: string | undefined;
  compatibility: "supported" | "unsupported" | "unknown";
} {
  const match = /^codex-cli (\d{1,4}\.\d{1,4}\.\d{1,6})\s*$/.exec(output.trim());
  const version = match?.[1];
  if (version === undefined) return { version: undefined, compatibility: "unknown" };
  return { version, compatibility: version === "0.167.0" ? "supported" : "unsupported" };
}
