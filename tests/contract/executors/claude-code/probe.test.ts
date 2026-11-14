// Contract: version compatibility and login-mode probe, against a fake `claude`.
// The probe runs only `--version` and `auth status --json`: no model call, no quota.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeResultSchema } from "../../../../src/application/contracts/agent-execution.js";
import { ClaudeCodeExecutor } from "../../../../src/infrastructure/executors/claude-code/claude-code-executor.js";
import {
  checkClaudeCodeVersion,
  SUPPORTED_CLAUDE_CODE_RANGE,
} from "../../../../src/infrastructure/executors/claude-code/claude-code-version.js";
import {
  fixture,
  readInvocations,
  writeFakeClaude,
  type FakeClaudeScenario,
} from "./fake-claude-cli.js";

let root: string;
let profile: string;
let counter = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "omi-claude-probe-"));
  profile = join(root, "profile");
  mkdirSync(profile);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function probeWith(scenario: FakeClaudeScenario, executable?: string) {
  counter += 1;
  const recordPath = join(root, `record-${String(counter)}.jsonl`);
  const path =
    executable ?? writeFakeClaude(root, `claude-${String(counter)}`, scenario, recordPath);
  const executor = new ClaudeCodeExecutor({
    executable: path,
    parentEnv: { PATH: process.env["PATH"] ?? "", ANTHROPIC_API_KEY: "sk-ant-must-not-leak" },
  });
  return { executor, invocations: () => readInvocations(recordPath) };
}

const SUPPORTED: FakeClaudeScenario = {
  versionOutput: "2.1.322 (Claude Code)\n",
  authStatusOutput: fixture("auth-status-subscription.json"),
};

describe("version compatibility", () => {
  it("documents the supported range", () => {
    expect(SUPPORTED_CLAUDE_CODE_RANGE.description).toBe(">=2.1.322 <2.2.0");
  });

  it.each([
    ["2.1.322 (Claude Code)", "supported", "2.1.322"],
    ["2.1.322 (Claude Code)\n", "supported", "2.1.322"],
    ["2.1.999 (Claude Code)", "supported", "2.1.999"],
    ["2.1.321 (Claude Code)", "unsupported", "2.1.321"],
    ["2.2.0 (Claude Code)", "unsupported", "2.2.0"],
    ["2.0.99 (Claude Code)", "unsupported", "2.0.99"],
    ["3.0.0 (Claude Code)", "unsupported", "3.0.0"],
    ["1.9.9", "unsupported", "1.9.9"],
    ["", "unknown", undefined],
    ["claude: command not found", "unknown", undefined],
    ["v2.1.400", "supported", "2.1.400"],
    ["2.1 (Claude Code)", "unknown", undefined],
    ["2.1.322-beta (Claude Code)", "unknown", undefined],
  ] as const)("%j is %s", (output, compatibility, version) => {
    expect(checkClaudeCodeVersion(output)).toEqual({ version, compatibility });
  });
});

describe("probe", () => {
  it("is ready for a supported version on a subscription login, with no account identifiers", async () => {
    const { executor, invocations } = probeWith(SUPPORTED);
    const result = await executor.probe({ profileHome: profile });
    expect(probeResultSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({
      executor: "claude-code",
      status: "ready",
      version: "2.1.322",
      compatibility: "supported",
      supportedRange: ">=2.1.322 <2.2.0",
      subscriptionType: "pro",
      loginExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of ["example.invalid", "Fixture Org", "0000-4000", "/home/fixture"]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Only the two cheap commands ran, on the requested profile, without inherited credentials.
    const runs = invocations();
    expect(runs.map((r) => r.argv)).toEqual([["--version"], ["auth", "status", "--json"]]);
    for (const run of runs) {
      expect(run.claudeConfigDir).toBe(profile);
      expect(run.envKeys).not.toContain("ANTHROPIC_API_KEY");
    }
  });

  it("does not look at the login of a version it does not support", async () => {
    const { executor, invocations } = probeWith({
      ...SUPPORTED,
      versionOutput: "2.2.0 (Claude Code)\n",
    });
    const result = await executor.probe({ profileHome: profile });
    expect(result).toMatchObject({
      status: "unsupported-version",
      compatibility: "unsupported",
      version: "2.2.0",
    });
    expect(result.diagnostic).toContain(">=2.1.322 <2.2.0");
    expect(invocations().map((r) => r.argv[0])).toEqual(["--version"]);
  });

  it("fails closed on version output it cannot read", async () => {
    const { executor } = probeWith({ ...SUPPORTED, versionOutput: "something else\n" });
    expect(await executor.probe({ profileHome: profile })).toMatchObject({
      status: "unsupported-version",
      compatibility: "unknown",
    });
  });

  it("reports login-required for a logged-out profile even when the CLI exits non-zero", async () => {
    const { executor } = probeWith({
      ...SUPPORTED,
      authStatusOutput: fixture("auth-status-logged-out.json"),
      authStatusExitCode: 1,
    });
    expect(await executor.probe({ profileHome: profile })).toMatchObject({
      status: "login-required",
      compatibility: "supported",
    });
  });

  it("refuses an API-key login: only the subscription path is supported", async () => {
    const { executor } = probeWith({
      ...SUPPORTED,
      authStatusOutput: fixture("auth-status-api-key.json"),
    });
    expect(await executor.probe({ profileHome: profile })).toMatchObject({
      status: "unsupported-auth-mode",
    });
  });

  it("is unavailable, not ready, when the login status cannot be read", async () => {
    const { executor } = probeWith({ ...SUPPORTED, authStatusOutput: "<html>oops</html>" });
    expect(await executor.probe({ profileHome: profile })).toMatchObject({ status: "unavailable" });
  });

  it("is unavailable when the CLI is not installed or --version fails", async () => {
    expect(
      await probeWith({}, join(root, "no-such-claude")).executor.probe({ profileHome: profile }),
    ).toMatchObject({
      status: "unavailable",
      compatibility: "unknown",
      diagnostic: expect.stringMatching(/executable.*not found.*omi install --apply/) as unknown,
    });
    const failing = probeWith({ versionOutput: "2.1.322", versionExitCode: 3 });
    expect(await failing.executor.probe({ profileHome: profile })).toMatchObject({
      status: "unavailable",
    });
  });

  it("rejects a profile directory that does not exist instead of creating one", async () => {
    const { executor, invocations } = probeWith(SUPPORTED);
    await expect(
      executor.probe({ profileHome: "/nonexistent-omi-dir/profile" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(invocations()).toEqual([]);
  });
});
