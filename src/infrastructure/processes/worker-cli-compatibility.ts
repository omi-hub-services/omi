import {
  checkClaudeCodeVersion,
  SUPPORTED_CLAUDE_CODE_RANGE,
} from "../executors/claude-code/claude-code-version.js";
import { checkCodexVersion, SUPPORTED_CODEX_RANGE } from "../executors/codex/codex-version.js";

export type WorkerCliClassification = "supported" | "untested" | "unsupported";

const isOlder = (version: string, min: { major: number; minor: number; patch: number }) => {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return (major - min.major || minor - min.minor || patch - min.patch) < 0;
};

/**
 * Doctor view of the adapters' own ranges (compatibility.md): in range = supported; newer than the
 * range = untested (never checked, the adapter refuses it until widened); older or unrecognised =
 * unsupported. The ranges live only in the executor version modules.
 */
export function classifyWorkerCli(
  cli: "claude" | "codex",
  output: string,
): { classification: WorkerCliClassification; version: string | undefined; range: string } {
  const { version, compatibility } =
    cli === "claude" ? checkClaudeCodeVersion(output) : checkCodexVersion(output);
  const supported = cli === "claude" ? SUPPORTED_CLAUDE_CODE_RANGE : SUPPORTED_CODEX_RANGE;
  const range = supported.description;
  if (version === undefined) return { classification: "unsupported", version, range };
  if (compatibility === "supported") return { classification: "supported", version, range };
  return {
    classification: isOlder(version, supported.min) ? "unsupported" : "untested",
    version,
    range,
  };
}
