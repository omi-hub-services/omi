import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { startSupervisedProcess } from "../../../src/infrastructure/processes/supervised-process.ts";

it("refuses configured credential values in worker log lines and stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omi-secret-output-"));
  const script = join(dir, "fake-worker.cjs");
  await writeFile(
    script,
    "process.stdout.write('fake-configured-value\\n'); process.stderr.write('fake-configured-value');",
  );
  try {
    const lines: string[] = [];
    const worker = await startSupervisedProcess({
      executable: process.execPath,
      args: [script],
      cwd: "/tmp",
      env: {},
      stdin: "",
      onStdoutLine: (line) => {
        lines.push(line);
      },
      timeoutMs: 3000,
      graceMs: 100,
      maxStdoutChars: 10000,
      maxLineChars: 10000,
      maxStderrChars: 10000,
      credentialPolicy: { sensitiveValues: ["fake-configured-value"] },
    });
    const exit = await worker.exit;
    expect(lines).toEqual([]);
    expect(exit.stderr).not.toContain("fake-configured-value");
    expect(exit.exitCode).not.toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("refuses configured credentials in process input before spawning", async () => {
  await expect(
    startSupervisedProcess({
      executable: "unused",
      args: [],
      cwd: "/tmp",
      env: {},
      stdin: "fake-configured-value",
      onStdoutLine: () => {},
      timeoutMs: 3000,
      graceMs: 100,
      maxStdoutChars: 10000,
      maxLineChars: 10000,
      maxStderrChars: 10000,
      credentialPolicy: { sensitiveValues: ["fake-configured-value"] },
    }),
  ).rejects.toThrow("credential");
});
