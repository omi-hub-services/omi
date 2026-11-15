import { readFileSync } from "node:fs";

/**
 * True while the process exists and is not a zombie. A zombie only waits to be reaped and runs
 * nothing, so for "did the worker stop" it counts as stopped.
 */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    // `pid (comm) S ...`: comm may contain spaces and parentheses, so anchor on the last ") ".
    return !/^\d+ \(.*\) Z /.test(stat);
  } catch {
    return false;
  }
}

/** The scheduler state letter from /proc (R, S, T, Z, ...), or undefined when it is gone. */
export function processState(pid: number): string | undefined {
  try {
    return /^\d+ \(.*\) (\w) /.exec(readFileSync(`/proc/${String(pid)}/stat`, "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

/** Polls a condition; fails with `what` after `limitMs`. No fixed sleeps: it returns as soon as true. */
export async function waitFor(
  condition: () => boolean,
  what: string,
  limitMs = 15_000,
): Promise<void> {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > limitMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Every pid or process group this test run created and recorded. It is the only thing the tests
 * ever signal: `signal` refuses an id that was not registered (AC-4, and the safety rule that other
 * sessions on this machine are never touched).
 */
export class OwnedProcesses {
  private readonly ids = new Set<number>();

  add(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to own pid ${String(pid)}`);
    this.ids.add(pid);
  }

  /** `target` is a pid, or `-pgid` for a whole group. Ignores "already gone". */
  signal(target: number, signal: NodeJS.Signals): void {
    if (!this.ids.has(Math.abs(target))) {
      throw new Error(`refusing to signal ${String(target)}: not created by this test`);
    }
    try {
      process.kill(target, signal);
    } catch {
      // already gone
    }
  }

  clear(): void {
    this.ids.clear();
  }
}
