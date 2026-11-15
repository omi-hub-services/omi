import type { ProbeResult } from "../../../application/contracts/agent-execution.js";
import { runCommand } from "../../processes/run-command.js";
import { inspectCodexAuth } from "./codex-auth.js";
import { checkCodexVersion, SUPPORTED_CODEX_RANGE } from "./codex-version.js";

export async function probeCodex(options: {
  executable: string;
  env: Readonly<Record<string, string>>;
  cwd: string;
  profileHome: string;
}): Promise<ProbeResult> {
  const base = { executor: "codex", supportedRange: SUPPORTED_CODEX_RANGE.description } as const;
  const run = await runCommand({ ...options, args: ["--version"], timeoutMs: 30_000 });
  if (
    run.kind !== "finished" ||
    run.exit.exitCode !== 0 ||
    run.exit.signal !== null ||
    run.exit.timedOut ||
    run.exit.stdoutOverflow
  ) {
    return {
      ...base,
      status: "unavailable",
      compatibility: "unknown",
      diagnostic:
        run.kind === "spawn-failed"
          ? "codex executable not found or not runnable; install codex, then run omi install --apply (or update --apply) from a WSL shell where codex is on PATH and restart the session"
          : "codex --version did not run successfully; check the CLI and Node.js, rerun omi install --apply (or update --apply) from a working WSL shell, then restart the session",
    };
  }
  const { version, compatibility } = checkCodexVersion(run.stdout);
  const fields = { ...base, compatibility, ...(version === undefined ? {} : { version }) };
  if (compatibility !== "supported") {
    return {
      ...fields,
      status: "unsupported-version",
      diagnostic: "codex version is unknown or outside the supported range",
    };
  }
  const status = await inspectCodexAuth(options.profileHome);
  return {
    ...fields,
    status,
    ...(status === "ready" ? {} : { diagnostic: "profile requires a subscription file login" }),
  };
}
