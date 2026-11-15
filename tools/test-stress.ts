// Manual only: ten independent suites contend with a CPU burner; never included in check.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const build = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
if (build.status !== 0) process.exit(1);
mkdirSync(join(root, ".tmp"), { recursive: true });
const logs = mkdtempSync(join(root, ".tmp", "test-stress-"));
const files = process.argv.slice(2);
if (files.length === 0)
  files.push(
    "tests/e2e/runtime-composition.test.ts",
    "tests/integration/processes/session-entrypoint.test.ts",
    "tests/e2e/package-installation.test.ts",
  );
const load = spawn(process.execPath, ["--eval", "for (;;) Math.sqrt(Math.random());"], {
  stdio: "ignore",
});
const running = new Set<number>();
const stop = () => {
  load.kill("SIGKILL");
  for (const pid of running) process.kill(-pid, "SIGKILL");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const started = performance.now();
try {
  const results = await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const log = openSync(join(logs, `run-${String(index + 1)}.log`), "w");
      const child = spawn(
        process.execPath,
        [join(root, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1", ...files],
        { cwd: root, stdio: ["ignore", log, log], detached: true },
      );
      closeSync(log);
      // Bound hung child/cleanup paths too; a timeout fails the run and is never a retry.
      const pid = child.pid;
      if (pid === undefined) throw new Error("Could not start stress runner");
      running.add(pid);
      const deadline = setTimeout(() => process.kill(-pid, "SIGKILL"), 180_000);
      const code = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("close", done);
      }).finally(() => {
        clearTimeout(deadline);
        running.delete(pid);
      });
      console.log(
        `run ${String(index + 1)}: ${code === 0 ? "PASS" : `FAIL (exit=${String(code)}, signal=${String(child.signalCode)})`}`,
      );
      return code === 0;
    }),
  );
  const passed = results.filter(Boolean).length;
  console.log(
    `Stress: ${String(passed)}/10 passed in ${((performance.now() - started) / 1000).toFixed(1)}s; logs: ${logs}`,
  );
  process.exitCode = passed === 10 ? 0 : 1;
} finally {
  stop();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
