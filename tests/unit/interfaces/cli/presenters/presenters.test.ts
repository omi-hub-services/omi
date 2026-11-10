import { describe, expect, it } from "vitest";
import {
  CLIENT_ERROR_CODES,
  SERVER_ERROR_CODES,
} from "../../../../../src/interfaces/ipc/protocol.js";
import {
  EXIT_CODES,
  exitCodeForError,
} from "../../../../../src/interfaces/cli/presenters/exit-codes.js";
import {
  presentFailure,
  presentUsageError,
} from "../../../../../src/interfaces/cli/presenters/result-presenter.js";
import { presentStatus } from "../../../../../src/interfaces/cli/presenters/status-presenter.js";

const status = {
  schemaVersion: 1,
  state: "ready",
  runtimeVersion: "0.0.0",
  startedAt: "2026-11-10T12:00:00.000Z",
};

describe("exit codes", () => {
  it("keeps the documented numbers stable", () => {
    expect(EXIT_CODES).toEqual({
      OK: 0,
      FAILURE: 1,
      USAGE: 2,
      RUNTIME_UNAVAILABLE: 3,
      REQUEST_REJECTED: 4,
      PROTOCOL_ERROR: 5,
    });
  });

  it("maps every IPC error code to a non-zero exit code", () => {
    for (const code of [...SERVER_ERROR_CODES, ...CLIENT_ERROR_CODES]) {
      expect(exitCodeForError(code)).toBeGreaterThan(0);
    }
    expect(exitCodeForError("TIMEOUT")).toBe(EXIT_CODES.RUNTIME_UNAVAILABLE);
    expect(exitCodeForError("PAYLOAD_TOO_LARGE")).toBe(EXIT_CODES.REQUEST_REJECTED);
    expect(exitCodeForError("INTERNAL_ERROR")).toBe(EXIT_CODES.FAILURE);
  });
});

describe("status presenter", () => {
  it("renders text on stdout with exit 0", () => {
    const out = presentStatus({ ok: true, result: status }, "text");
    expect(out).toEqual({
      stdout: "runtime: ready\nversion: 0.0.0\nstarted: 2026-11-10T12:00:00.000Z\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("renders one JSON document with schema version, exit code and result", () => {
    const out = presentStatus({ ok: true, result: status }, "json");
    expect(out.stderr).toBe("");
    expect(JSON.parse(out.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      exitCode: 0,
      result: status,
    });
    expect(out.stdout.endsWith("\n")).toBe(true);
  });

  it("reports an error on stderr in text mode and on stdout in JSON mode", () => {
    const error = { code: "RUNTIME_UNAVAILABLE", message: "no runtime" } as const;
    const text = presentStatus({ ok: false, error }, "text");
    expect(text).toEqual({
      stdout: "",
      stderr: "error[RUNTIME_UNAVAILABLE]: no runtime\n",
      exitCode: 3,
    });
    const json = presentStatus({ ok: false, error }, "json");
    expect(json.stderr).toBe("");
    expect(json.exitCode).toBe(3);
    expect(JSON.parse(json.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      exitCode: 3,
      error: { code: "RUNTIME_UNAVAILABLE", message: "no runtime" },
    });
  });

  it("treats a result of the wrong shape as a protocol error, never as status", () => {
    for (const result of [{ state: "ready" }, { ...status, extra: 1 }, "ready", null]) {
      const out = presentStatus({ ok: true, result }, "text");
      expect(out.exitCode).toBe(EXIT_CODES.PROTOCOL_ERROR);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("error[PROTOCOL_ERROR]");
    }
  });

  it("strips control characters from error text so a peer cannot drive the terminal", () => {
    const out = presentFailure(
      { code: "INVALID_COMMAND", message: "bad\u001b[2Jinput\r\nx" },
      "text",
    );
    expect(out.stderr).toBe("error[INVALID_COMMAND]: bad?[2Jinput??x\n");
  });
});

describe("usage errors", () => {
  it("exit 2 in both formats", () => {
    expect(presentUsageError("unknown command", "text")).toEqual({
      stdout: "",
      stderr: "error[USAGE]: unknown command\n",
      exitCode: 2,
    });
    const json = presentUsageError("unknown command", "json");
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      error: { code: "USAGE" },
    });
  });
});
