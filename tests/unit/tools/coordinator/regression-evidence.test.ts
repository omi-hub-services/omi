import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { regressionEvidenceCommand } from "../../../../tools/coordinator/regression-evidence.ts";
import { validRegressionEvidence } from "../../../../src/application/services/validate-review-evidence.ts";

import type { RegressionExecutor as Executor } from "../../../../src/application/ports/regression-runner.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
let dir: string;
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-regression-"));
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...s: unknown[]) => void lines.push(s.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...s: unknown[]) => void lines.push(s.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const run = (baseExit: number | null, headExit: number | null, over = {}) => {
  const out = join(dir, "evidence.json");
  const execute = vi.fn<Executor>((where) =>
    Promise.resolve(
      where === "base"
        ? { revision: base, exitCode: baseExit }
        : { revision: head, exitCode: headExit },
    ),
  );
  return {
    out,
    execute,
    status: regressionEvidenceCommand({
      worktree: dir,
      testFile: "tests/unit/a.test.ts",
      testName: "fixes it",
      out,
      base,
      execute,
      ...over,
    }),
  };
};

it("writes red on the base and green on the head for review-comment to read", async () => {
  const r = run(1, 0);
  expect(await r.status).toBe(0);
  const evidence = JSON.parse(readFileSync(r.out, "utf8")) as unknown;
  expect(validRegressionEvidence(evidence, base, head)).toBe(true);
  expect(r.execute.mock.calls[0]?.[1]).toEqual([
    "npm",
    "run",
    "test:unit",
    "--",
    "tests/unit/a.test.ts",
    "-t",
    "fixes it",
  ]);
});

it.each([
  ["green on the base", 0, 0],
  ["red on the head", 1, 1],
])("refuses %s but still records what ran", async (_label, baseExit, headExit) => {
  const r = run(baseExit, headExit);
  expect(await r.status).toBe(1);
  expect(existsSync(r.out)).toBe(true);
  expect(lines.join("\n")).toContain("must fail on the base and pass on the head");
});

it("refuses a run without an exit status and writes no evidence", async () => {
  const r = run(null, 0);
  expect(await r.status).toBe(1);
  expect(existsSync(r.out)).toBe(false);
});

it("runs git and both test runs in the WSL checkout and writes the evidence to the Coordinator path", async () => {
  const out = join(dir, "wsl-evidence.json");
  const target = { viaWslExe: true, distro: "Ubuntu-24.04", repoDir: "/home/u/omi" };
  const calls: { file: string; args: readonly string[] }[] = [];
  const runner = vi.fn((command: { file: string; args: readonly string[] }) => {
    calls.push(command);
    const payload = command.args.at(-1) ?? "";
    const stdout = payload.startsWith("git merge-base")
      ? `${base}\n`
      : payload.startsWith("git rev-parse --verify")
        ? `${base}\n`
        : payload.startsWith("git rev-parse HEAD")
          ? `${head}\n`
          : "";
    return Promise.resolve({ code: payload.includes("worktree add") ? 1 : 0, stdout, stderr: "" });
  });
  const status = await regressionEvidenceCommand({
    testFile: "tests/unit/a.test.ts",
    testName: "fixes it",
    out,
    run: runner,
    target,
  });
  expect(status).toBe(0);
  expect(
    validRegressionEvidence(JSON.parse(readFileSync(out, "utf8")) as unknown, base, head),
  ).toBe(true);
  expect(calls.every((c) => c.file === "wsl.exe")).toBe(true);
  expect(calls.every((c) => c.args.join(" ").includes("--cd /home/u/omi"))).toBe(true);
  const payloads = calls.map((c) => c.args.at(-1) ?? "");
  expect(payloads[0]).toBe("git merge-base HEAD origin/develop");
  expect(payloads.some((p) => p.includes("worktree add --detach"))).toBe(true);
  expect(decodedArgs(payloads)).toContainEqual([
    "npm",
    "run",
    "test:unit",
    "--",
    "tests/unit/a.test.ts",
    "-t",
    "fixes it",
  ]);
});

const decodedArgs = (payloads: string[]) =>
  payloads.flatMap((p) =>
    [...p.matchAll(/echo (\S+) \| base64 -d/g)].map((m) =>
      Buffer.from(m[1] ?? "", "base64")
        .toString()
        .split("\0"),
    ),
  );

const wslRun = (testName: string, runnerCode: (payload: string) => number) => {
  const target = { viaWslExe: true, distro: "d", repoDir: "/home/u/omi" };
  const payloads: string[] = [];
  const runner = (command: { args: readonly string[] }) => {
    const payload = command.args.at(-1) ?? "";
    payloads.push(payload);
    const stdout = payload.startsWith("git rev-parse HEAD") ? `${head}\n` : `${base}\n`;
    return Promise.resolve({ code: runnerCode(payload), stdout, stderr: "" });
  };
  const status = regressionEvidenceCommand({
    testFile: "tests/unit/a.test.ts",
    testName,
    out: join(dir, "e.json"),
    run: runner,
    target,
    base,
  });
  return { payloads, status };
};

it.each([`handles user's input`, `says "hi"`, String.raw`matches \d+ and a\\b`])(
  "carries the test name %s to WSL without a quote or backslash in the payload",
  async (name) => {
    const r = wslRun(name, (p) => (p.includes("worktree add") ? 1 : 0));
    expect(await r.status).toBe(0);
    expect(decodedArgs(r.payloads).some((a) => a.at(-1) === name)).toBe(true);
  },
);

it("removes the throwaway base worktree in a separate WSL call even when the run times out", async () => {
  const r = wslRun("fixes it", (p) => (p.includes("worktree add") ? 128 : 0));
  expect(await r.status).toBe(1);
  const run = r.payloads.find((p) => p.includes("worktree add")) ?? "";
  const path = /--detach (\S+)/.exec(run)?.[1] ?? "";
  const cleanup = r.payloads.find((p) => p.startsWith("git worktree remove"));
  expect(cleanup).toContain(path);
  expect(cleanup).toContain(`rm -rf ${path.replace("/base", "")}`);
});

it.each(["src/a.test.ts", "../tests/unit/a.test.ts", "tests/other/a.test.ts"])(
  "refuses the test file %s",
  async (testFile) => {
    const r = run(1, 0, { testFile });
    expect(await r.status).toBe(1);
    expect(r.execute).not.toHaveBeenCalled();
  },
);
