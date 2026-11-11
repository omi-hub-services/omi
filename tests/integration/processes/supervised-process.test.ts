import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startSupervisedProcess,
  type SupervisedProcess,
  type SupervisedProcessOptions,
} from "../../../src/infrastructure/processes/supervised-process.js";

// Real child processes (Node scripts in a temp dir), no CLI and no login.
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-supervised-process-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function script(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

function start(
  scriptPath: string,
  lines: string[],
  overrides: Partial<SupervisedProcessOptions> = {},
): Promise<SupervisedProcess> {
  return startSupervisedProcess({
    executable: process.execPath,
    args: [scriptPath],
    cwd: dir,
    env: {},
    stdin: "",
    onStdoutLine: (line) => lines.push(line),
    timeoutMs: 20_000,
    graceMs: 5000,
    maxStdoutChars: 1_000_000,
    maxLineChars: 100_000,
    maxStderrChars: 1000,
    ...overrides,
  });
}

async function runToEnd(
  scriptPath: string,
  overrides: Partial<SupervisedProcessOptions> = {},
): Promise<{ lines: string[]; exit: Awaited<SupervisedProcess["exit"]> }> {
  const lines: string[] = [];
  const supervised = await start(scriptPath, lines, overrides);
  return { lines, exit: await supervised.exit };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 10_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("startSupervisedProcess", () => {
  it("frames stdout into lines (split chunks, CRLF, last line without a newline)", async () => {
    const path = script(
      "framing.mjs",
      `process.stdout.write("one\\r\\ntw");
       setTimeout(() => process.stdout.write("o\\nlast"), 50);`,
    );
    const { lines, exit } = await runToEnd(path);
    expect(lines).toEqual(["one", "two", "last"]);
    expect(exit.exitCode).toBe(0);
    expect(exit.durationMs).toBeGreaterThan(0);
  });

  it("passes the prompt over stdin and exactly the given environment", async () => {
    const path = script(
      "env-stdin.mjs",
      `let input = "";
       process.stdin.setEncoding("utf8");
       process.stdin.on("data", (c) => (input += c));
       process.stdin.on("end", () => {
         console.log(JSON.stringify({ input, env: Object.keys(process.env).sort() }));
       });`,
    );
    const { lines } = await runToEnd(path, {
      stdin: "hello $(whoami) 'quoted'",
      env: { ONLY: "1" },
    });
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      input: "hello $(whoami) 'quoted'",
      env: ["ONLY"],
    });
  });

  it("cancels with SIGINT and does not escalate when the child exits in time", async () => {
    const path = script(
      "graceful.mjs",
      `process.on("SIGINT", () => { console.log("bye"); process.exit(0); });
       console.log("ready");
       setInterval(() => undefined, 1000);`,
    );
    const lines: string[] = [];
    const supervised = await start(path, lines);
    await waitFor(() => lines.includes("ready"), "the child to be ready");
    supervised.cancel();
    supervised.cancel(); // idempotent
    const exit = await supervised.exit;
    expect(lines).toContain("bye");
    expect(exit).toMatchObject({
      exitCode: 0,
      cancelRequested: true,
      timedOut: false,
      escalated: false,
      leftoverProcessesKilled: false,
    });
  });

  it("kills the process group after the grace period when SIGINT is ignored", async () => {
    const path = script(
      "stubborn.mjs",
      `process.on("SIGINT", () => undefined);
       console.log("ready");
       setInterval(() => undefined, 1000);`,
    );
    const lines: string[] = [];
    const supervised = await start(path, lines, { graceMs: 300 });
    await waitFor(() => lines.includes("ready"), "the child to be ready");
    supervised.cancel();
    const exit = await supervised.exit;
    expect(exit).toMatchObject({ signal: "SIGKILL", cancelRequested: true, escalated: true });
  });

  it("kills a group member that outlives the child, and does not call that escalation", async () => {
    const path = script(
      "orphan.mjs",
      `import { spawn } from "node:child_process";
       const grandchild = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
         stdio: "ignore",
       });
       process.on("SIGINT", () => process.exit(0));
       console.log("grandchild " + grandchild.pid);
       setInterval(() => undefined, 1000);`,
    );
    const lines: string[] = [];
    const supervised = await start(path, lines);
    await waitFor(() => lines.length > 0, "the grandchild pid");
    supervised.cancel();
    const exit = await supervised.exit;
    const pid = Number((lines[0] ?? "").replace("grandchild ", ""));
    expect(pid).toBeGreaterThan(0);
    expect(exit.escalated).toBe(false);
    expect(exit.leftoverProcessesKilled).toBe(true);
    // SIGKILL is delivered at close; the init process reaps the orphan shortly after.
    await waitFor(() => !isAlive(pid), "the group member to die");
  });

  it("cancels a run that exceeds its time limit and reports it as timed out", async () => {
    const path = script("slow.mjs", `setInterval(() => undefined, 1000);`);
    const { exit } = await runToEnd(path, { timeoutMs: 300 });
    expect(exit).toMatchObject({ timedOut: true, cancelRequested: false, signal: "SIGINT" });
  });

  it("kills a run whose stdout exceeds the limit", async () => {
    const path = script(
      "flood.mjs",
      `const chunk = "x".repeat(1000) + "\\n";
       setInterval(() => process.stdout.write(chunk), 1);`,
    );
    const { exit } = await runToEnd(path, { maxStdoutChars: 20_000 });
    expect(exit.stdoutOverflow).toBe(true);
    expect(exit.signal).toBe("SIGKILL");
  });

  it("kills a run that never ends a line", async () => {
    const path = script(
      "endless-line.mjs",
      `setInterval(() => process.stdout.write("y".repeat(1000)), 1);`,
    );
    const { exit } = await runToEnd(path, { maxLineChars: 5000 });
    expect(exit.stdoutOverflow).toBe(true);
  });

  it("bounds stderr", async () => {
    const path = script("noisy.mjs", `process.stderr.write("e".repeat(5000));`);
    const { exit } = await runToEnd(path, { maxStderrChars: 100 });
    expect(exit.stderr).toHaveLength(100);
  });

  it("rejects when the executable cannot be spawned", async () => {
    await expect(
      start(join(dir, "unused.mjs"), [], { executable: join(dir, "does-not-exist") }),
    ).rejects.toThrow();
  });
});
