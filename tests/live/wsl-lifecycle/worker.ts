// Stand-in for a Claude/Codex worker (no CLI, no quota). Run by runtime-entry.ts through the
// supervised process layer, so it leads its own process group.
// Usage: node worker.ts <workDir> <stateDir> <polite|stubborn>
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [workDir, stateDir, behaviour] = process.argv.slice(2);
if (workDir === undefined || stateDir === undefined || behaviour === undefined) {
  throw new Error("usage: worker.ts <workDir> <stateDir> <polite|stubborn>");
}

// Work in progress that nobody committed: the lifecycle must never clean this up.
writeFileSync(join(workDir, "worker-output.txt"), "uncommitted worker output\n");

// A tool subprocess in the same group, like a shell command a real worker would run.
const tool = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
  stdio: "ignore",
});

process.on("SIGINT", () => {
  if (behaviour === "stubborn") return; // ignores the interrupt: only the group SIGKILL ends it
  writeFileSync(join(stateDir, "worker-checkpoint.txt"), "interrupted\n");
  process.exit(0);
});

// Printed only after the handler exists, so "ready" means an interrupt is handled.
console.log(`tool ${String(tool.pid)}`);
setInterval(() => undefined, 1000);
