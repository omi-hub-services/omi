// Test-only stand-in for the WSL2 runtime process of ADR-0012: it owns one worker group and
// watches the pipe on its stdin. The real runtime (OMI-016) does not exist yet.
// Run: node --import ./tools/register-ts-imports.ts tests/live/wsl-lifecycle/runtime-entry.ts '<json>'
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runWorkerUnderOwner } from "../../../src/infrastructure/processes/owned-worker-run.js";

const Config = z.strictObject({
  workDir: z.string().min(1),
  stateDir: z.string().min(1),
  workerScript: z.string().min(1),
  behaviour: z.enum(["polite", "stubborn"]),
  heartbeatTimeoutMs: z.number().int().positive(),
  graceMs: z.number().int().positive(),
});
const config = Config.parse(JSON.parse(process.argv[2] ?? ""));

// The launcher may be gone when we print; that must never crash the runtime.
process.stdout.on("error", () => undefined);

let announceToolPid: (pid: number) => void = () => undefined;
const toolPid = new Promise<number>((resolve) => {
  announceToolPid = resolve;
});

const run = await runWorkerUnderOwner({
  worker: {
    executable: process.execPath,
    args: [config.workerScript, config.workDir, config.stateDir, config.behaviour],
    cwd: config.workDir,
    env: {},
    stdin: "",
    onStdoutLine: (line) => {
      // Printed by the worker after its interrupt handler exists; this is the readiness signal.
      if (line.startsWith("tool ")) announceToolPid(Number(line.slice(5)));
    },
    timeoutMs: 120_000,
    graceMs: config.graceMs,
    maxStdoutChars: 100_000,
    maxLineChars: 10_000,
    maxStderrChars: 10_000,
  },
  owner: {
    channel: process.stdin,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    signals: ["SIGTERM", "SIGHUP"],
  },
});

// Our own signal and pipe handlers exist (installed inside runWorkerUnderOwner) before this line.
// If the owner vanished before the worker got ready, there is nothing to announce.
const readyToolPid = await Promise.race([toolPid, run.result.then(() => null)]);
if (readyToolPid !== null) {
  console.log(
    `ready ${JSON.stringify({
      runtimePid: process.pid,
      workerPid: run.worker.pid, // also the process group id
      toolPid: readyToolPid,
    })}`,
  );
}

const { ownerGone, workerExit } = await run.result;
writeFileSync(
  join(config.stateDir, "runtime-report.json"),
  JSON.stringify({
    ownerGone,
    exitCode: workerExit.exitCode,
    signal: workerExit.signal,
    cancelRequested: workerExit.cancelRequested,
    escalated: workerExit.escalated,
    leftoverProcessesKilled: workerExit.leftoverProcessesKilled,
  }),
);
process.exit(0);
