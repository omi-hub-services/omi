import { describe, expect, it } from "vitest";
import type { Command } from "../../../../src/application/contracts/command.ts";
import { runCli } from "../../../../src/interfaces/cli/commands/create-program.ts";
import type { IpcOutcome } from "../../../../src/interfaces/ipc/protocol.ts";

const claude = {
  metadata: {
    profileId: "worker-a",
    tool: "claude-code",
    credentialRef: "/home/u/.claude-profiles/worker-a",
    state: "unknown",
  },
  revision: 1,
  activeWorkers: 0,
};
const codex = {
  metadata: {
    profileId: "worker-b",
    tool: "codex",
    credentialRef: "/home/u/.codex-profiles/worker-b",
    state: "unknown",
  },
  revision: 1,
  activeWorkers: 0,
};

function harness(probe: IpcOutcome) {
  const calls: Command[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const run = (argv: string[]) =>
    runCli(argv, {
      sendCommand: (request: { command: Command }) => {
        calls.push(request.command);
        return Promise.resolve<IpcOutcome>(
          request.command.command === "profile.list"
            ? { ok: true, result: { profiles: [claude, codex] } }
            : probe,
        );
      },
      defaultSocketPath: "/runtime.sock",
      timeoutMs: 100,
      version: "test",
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
    });
  return { run, calls, out, err };
}

const ready: IpcOutcome = { ok: true, result: { outcome: "probed", status: "ready" } };
const loginRequired: IpcOutcome = {
  ok: true,
  result: { outcome: "probed", status: "login-required" },
};

describe("login command", () => {
  it("prints the native Claude command, probes, and exits 0 when ready", async () => {
    const h = harness(ready);
    expect(await h.run(["login", "worker-a"])).toBe(0);
    expect(h.calls.map((c) => c.command)).toEqual(["profile.list", "profile.probe"]);
    const text = h.out.join("");
    expect(text).toContain("CLAUDE_CONFIG_DIR=/home/u/.claude-profiles/worker-a claude");
    expect(text).toContain("/login");
    expect(text).toContain("ready");
  });

  it("prints the native Codex command for a codex profile", async () => {
    const h = harness(ready);
    expect(await h.run(["login", "worker-b"])).toBe(0);
    expect(h.out.join("")).toContain("CODEX_HOME=/home/u/.codex-profiles/worker-b codex login");
  });

  it("exits 4 and says login-required when the probe finds no login", async () => {
    const h = harness(loginRequired);
    expect(await h.run(["login", "worker-a"])).toBe(4);
    expect(h.out.join("")).toContain("login-required");
  });

  it("reports unavailable with exit 4 when the probe was skipped", async () => {
    const h = harness({ ok: true, result: { outcome: "cooldown" } });
    expect(await h.run(["login", "worker-a", "--json"])).toBe(4);
    const doc = JSON.parse(h.out.join("")) as { result: { status: string } };
    expect(doc.result.status).toBe("unavailable");
  });

  it("refuses an unknown profile without probing", async () => {
    const h = harness(ready);
    expect(await h.run(["login", "nope"])).toBe(4);
    expect(h.calls.map((c) => c.command)).toEqual(["profile.list"]);
    expect(h.err.join("")).toContain("PROFILE_NOT_FOUND");
  });

  it("emits one stable JSON document under --json", async () => {
    const h = harness(ready);
    expect(await h.run(["login", "worker-a", "--json"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({
      schemaVersion: 1,
      ok: true,
      exitCode: 0,
      result: {
        profileId: "worker-a",
        tool: "claude-code",
        status: "ready",
        login: {
          env: { CLAUDE_CONFIG_DIR: "/home/u/.claude-profiles/worker-a" },
          command: "claude",
          steps: "CLAUDE_CONFIG_DIR=/home/u/.claude-profiles/worker-a claude, then /login",
        },
      },
    });
  });

  it("never prints a credential value that the runtime might return", async () => {
    const h = harness({
      ok: true,
      result: { outcome: "probed", status: "ready", token: "sk-secret-123", refreshToken: "r-9" },
    });
    await h.run(["login", "worker-a"]);
    await h.run(["login", "worker-a", "--json"]);
    const all = h.out.join("") + h.err.join("");
    expect(all).not.toContain("sk-secret-123");
    expect(all).not.toContain("r-9");
  });

  it("passes a runtime refusal through with its exit code", async () => {
    const h = harness({
      ok: false,
      error: { code: "COMMAND_REFUSED", message: "PROFILE_PROBE_FAILED" },
    });
    expect(await h.run(["login", "worker-a"])).toBe(4);
    expect(h.err.join("")).toContain("PROFILE_PROBE_FAILED");
  });
});
