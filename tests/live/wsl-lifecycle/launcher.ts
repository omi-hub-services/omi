// Linux stand-in for the Windows launcher plus its long-lived `wsl.exe` child (ADR-0012): it owns
// the pipe to the runtime. It is NOT wsl.exe; what it proves is the runtime side of the contract.
//
// Graceful exit (SIGTERM): writes `stop`, closes the pipe, exits 0.
// Abrupt exit (SIGKILL): no code runs; the kernel closes the pipe, like Windows closing the
// handles of a killed launcher.
// Hang (SIGSTOP): the pipe stays open but no heartbeat is written.
//
// Usage: node launcher.ts <heartbeatMs> <command> [args...]
import { spawn } from "node:child_process";

const [heartbeatArg, command, ...args] = process.argv.slice(2);
const heartbeatMs = Number(heartbeatArg);
if (!Number.isFinite(heartbeatMs) || command === undefined) {
  throw new Error("usage: launcher.ts <heartbeatMs> <command> [args...]");
}

const runtime = spawn(command, args, {
  stdio: ["pipe", "pipe", "inherit"],
  env: { PATH: process.env.PATH ?? "" },
});
runtime.stdin.on("error", () => undefined);

// Relay the runtime's stdout like wsl.exe does; the first line the test sees is the runtime's.
runtime.stdout.pipe(process.stdout);

const heartbeat = (): void => {
  runtime.stdin.write("heartbeat\n");
};
heartbeat();
setInterval(heartbeat, heartbeatMs);

process.on("SIGTERM", () => {
  runtime.stdin.write("stop\n");
  runtime.stdin.end(() => process.exit(0));
});
// The runtime ends by itself after it stopped its worker; the launcher then has nothing left to do.
runtime.once("exit", () => process.exit(0));
