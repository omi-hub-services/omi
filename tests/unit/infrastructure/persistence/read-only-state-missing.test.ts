import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NoRuntimeStateError } from "../../../../src/application/ports/runtime-state.ts";
import { openReadOnlyStateDatabase } from "../../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { runCli } from "../../../../src/interfaces/cli/commands/create-program.ts";

describe("read-only status without a state database", () => {
  it("throws the named NO_RUNTIME_STATE error when the directory is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "omi-nostate-"));
    try {
      expect(() => openReadOnlyStateDatabase(join(dir, "missing", "state.sqlite"))).toThrow(
        NoRuntimeStateError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("presents status without state as NO_RUNTIME_STATE, not INTERNAL_ERROR", async () => {
    let err = "";
    const code = await runCli(["status", "--project", "/p"], {
      sendCommand: () => Promise.reject(new Error("unused")),
      defaultSocketPath: "/x",
      timeoutMs: 100,
      version: "0",
      stdout: () => undefined,
      stderr: (text: string) => {
        err += text;
      },
      overview: {
        status: () => Promise.reject(new NoRuntimeStateError()),
        watch: () => Promise.resolve(),
      },
    });
    expect(code).toBe(3);
    expect(err).toContain("NO_RUNTIME_STATE");
    expect(err).toContain("session start");
    expect(err).not.toContain("INTERNAL_ERROR");
  });
});
