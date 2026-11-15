import { describe, expect, it } from "vitest";
import {
  CHECK_ARGV,
  CHECK_ID,
  readStoredCheck,
  storeCheck,
} from "../../../../tools/coordinator/check-reuse.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

const target = { viaWslExe: false, distro: "d", repoDir: "/repo" };
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

/** In-memory stand-in for the `~/omi-runs/checks` directory behind the WSL payloads. */
function memory(): { run: Runner; files: Map<string, string> } {
  const files = new Map<string, string>();
  const run: Runner = (c: Command) => {
    const payload = c.args.at(-1) ?? "";
    const file = /checks\/([A-Za-z0-9.-]+\.json)/.exec(payload)?.[1] ?? "";
    if (payload.startsWith("cat ")) {
      const text = files.get(file);
      return Promise.resolve(
        text === undefined
          ? { code: 1, stdout: "", stderr: "" }
          : { code: 0, stdout: text, stderr: "" },
      );
    }
    files.set(file, c.input ?? "");
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { run, files };
}

const record = (over: Record<string, unknown> = {}) => ({
  checkId: CHECK_ID,
  head: HEAD,
  command: [...CHECK_ARGV],
  status: "passed" as const,
  exitCode: 0,
  log: "all green",
  ...over,
});

describe("stored check results", () => {
  it("returns a stored passed result for the same check id, head and command", async () => {
    const { run } = memory();
    await storeCheck(run, target, record());
    expect(await readStoredCheck(run, target, HEAD)).toMatchObject({
      status: "passed",
      head: HEAD,
      log: "all green",
    });
  });

  it("does not return a result for a different head or a different command", async () => {
    const { run } = memory();
    await storeCheck(run, target, record());
    expect(await readStoredCheck(run, target, OTHER)).toBeNull();
    expect(await readStoredCheck(run, target, HEAD, CHECK_ID, ["npm", "test"])).toBeNull();
  });

  it("returns a failed result as failed so the caller can never treat it as a pass", async () => {
    const { run } = memory();
    await storeCheck(run, target, record({ status: "failed", exitCode: 1 }));
    expect((await readStoredCheck(run, target, HEAD))?.status).toBe("failed");
  });

  it("treats a file whose content disagrees with its key as missing", async () => {
    const { run, files } = memory();
    await storeCheck(run, target, record());
    const [name] = [...files.keys()];
    files.set(name ?? "", JSON.stringify({ ...record(), head: OTHER }));
    expect(await readStoredCheck(run, target, HEAD)).toBeNull();
    files.set(name ?? "", "not json");
    expect(await readStoredCheck(run, target, HEAD)).toBeNull();
  });

  it("keeps only a redacted tail of the log", async () => {
    const { run, files } = memory();
    await storeCheck(run, target, record({ log: `${"x".repeat(9000)}\ntoken=abcdef123456 end` }));
    const stored = [...files.values()][0] ?? "";
    expect(stored).not.toContain("abcdef123456");
    expect((await readStoredCheck(run, target, HEAD))?.log.length).toBeLessThanOrEqual(4000);
  });
});
