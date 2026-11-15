// Exercise process lifecycle without a subscription, network access or the real Codex CLI.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWorkerEnv,
  classify,
  runCodex,
  type CliRunOptions,
} from "../../../live/codex-cli/codex-cli-process.js";

describe.skipIf(process.platform === "win32")(
  "Codex PoC process lifecycle (fake executable)",
  () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "omi-codex-process-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function run(script: string, options: Partial<CliRunOptions> = {}) {
      writeFileSync(join(dir, "codex"), `#!${process.execPath}\n${script}`, { mode: 0o700 });
      const env = buildWorkerEnv(
        { ...process.env, PATH: `${dir}${delimiter}${process.env["PATH"] ?? ""}` },
        dir,
      );
      return runCodex({
        args: [],
        prompt: "literal prompt $(never-a-shell-command)",
        cwd: dir,
        env,
        timeoutMs: 5000,
        ...options,
      });
    }

    it("parses split JSONL and a final unterminated event; stdin and API-key guard reach the child", async () => {
      const result = await run(`
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        if (process.env.OPENAI_API_KEY || !input.includes("$(never-a-shell-command)")) process.exit(3);
        process.stdout.write('{"type":"turn.');
        setTimeout(() => process.stdout.write('completed"}'), 20);
      });`);
      expect(classify(result)).toBe("success");
      expect(result.events.map((e) => e.type)).toEqual(["turn.completed"]);
      expect(result.groupAliveAtClose).toBe(false);
    });

    it("reports real nonzero exit, rejects non-JSON stdout, and scrubs chunked stderr", async () => {
      const result = await run(`
      process.stderr.write('Bearer synthetic-');
      setTimeout(() => {
        process.stderr.write('secret');
        process.stdout.write('malformed\\n{"type":"turn.failed"}\\n');
        process.exitCode = 7;
      }, 20);`);
      expect(result.exitCode).toBe(7);
      expect(result.unparsedStdoutLines).toBe(1);
      expect(result.stderr).toBe("Bearer [REDACTED]");
      expect(classify(result)).toBe("error");
    });

    it("sends SIGINT after start and leaves no process group", async () => {
      const result = await run(
        `
      process.on('SIGINT', () => process.exit(130));
      process.stdout.write('{"type":"turn.started"}\\n');
      setInterval(() => {}, 1000);`,
        {
          cancelOn: { eventType: "turn.started", delayMs: 20, signal: "SIGINT", graceMs: 1000 },
        },
      );
      expect(classify(result)).toBe("cancelled");
      expect(result.exitCode).toBe(130);
      expect(result.cancel?.escalated).toBe(false);
      expect(result.groupAliveAtClose).toBe(false);
    });

    it("escalates cancellation when the process ignores SIGINT", async () => {
      const result = await run(
        `
      process.on('SIGINT', () => {});
      process.stdout.write('{"type":"turn.started"}\\n');
      setInterval(() => {}, 1000);`,
        {
          cancelOn: { eventType: "turn.started", delayMs: 20, signal: "SIGINT", graceMs: 100 },
        },
      );
      expect(classify(result)).toBe("cancelled");
      expect(result.cancel?.escalated).toBe(true);
      expect(result.signal).toBe("SIGKILL");
      expect(result.groupAliveAtClose).toBe(false);
    });

    it("kills a stalled process at the hard deadline without classifying it as cancel", async () => {
      const result = await run("setInterval(() => {}, 1000);", { timeoutMs: 200 });
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe("SIGKILL");
      expect(classify(result)).toBe("error");
      expect(result.cancel).toBeUndefined();
      expect(result.groupAliveAtClose).toBe(false);
    });

    it("bounds stdout memory even for a line with no newline", async () => {
      const result = await run(
        "process.stdout.write('x'.repeat(9 * 1024 * 1024)); setInterval(() => {}, 1000);",
      );
      expect(result.outputLimitExceeded).toBe(true);
      expect(result.signal).toBe("SIGKILL");
      expect(classify(result)).toBe("error");
    });

    it("does not schedule cancellation from a final event received during close", async () => {
      const result = await run(`process.stdout.write('{"type":"turn.started"}');`, {
        cancelOn: { eventType: "turn.started", delayMs: 20, signal: "SIGINT", graceMs: 100 },
      });
      expect(result.cancel).toBeUndefined();
      expect(classify(result)).toBe("error");
    });

    it("rejects a spawn failure with a fixed message", async () => {
      await expect(run("", { env: { PATH: dir }, cwd: join(dir, "missing") })).rejects.toThrow(
        "codex spawn failed: Error",
      );
    });
  },
);
