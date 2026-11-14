import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeResultSchema } from "../../../../src/application/contracts/agent-execution.js";
import { CodexExecutor } from "../../../../src/infrastructure/executors/codex/codex-executor.js";
import * as auth from "../../../../src/infrastructure/executors/codex/codex-auth.js";
import {
  checkCodexVersion,
  SUPPORTED_CODEX_RANGE,
} from "../../../../src/infrastructure/executors/codex/codex-version.js";
import {
  fixture,
  readInvocations,
  writeFakeCodex,
  type FakeCodexScenario,
} from "./fake-codex-cli.js";

let root: string;
let profile: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omi-codex-probe-"));
  profile = join(root, "profile");
  mkdirSync(profile);
  writeFileSync(join(profile, "auth.json"), fixture("subscription-cache.json"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function harness(scenario: FakeCodexScenario = {}, executable?: string) {
  const record = join(root, "record.jsonl");
  return {
    executor: new CodexExecutor({
      executable: executable ?? writeFakeCodex(root, "codex", scenario, record),
      parentEnv: {
        PATH: process.env["PATH"] ?? "",
        OPENAI_API_KEY: "synthetic-key",
        CODEX_HOME: "/wrong/profile",
      },
    }),
    invocations: () => readInvocations(record),
  };
}

describe("Codex version compatibility", () => {
  it("pins the one CLI proven by ADR-0021", () => {
    expect(SUPPORTED_CODEX_RANGE.description).toBe(">=0.167.0 <0.167.1");
  });
  it.each([
    ["codex-cli 0.167.0\n", "supported", "0.167.0"],
    ["codex-cli 0.166.999", "unsupported", "0.166.999"],
    ["codex-cli 0.167.1", "unsupported", "0.167.1"],
    ["codex-cli 0.168.0", "unsupported", "0.168.0"],
    ["codex-cli 1.0.0", "unsupported", "1.0.0"],
    ["codex-cli 0.167.0-beta", "unknown", undefined],
    ["0.167.0", "unknown", undefined],
    ["", "unknown", undefined],
    ["codex-cli 0.167.0\nunexpected line", "unknown", undefined],
  ])("checks %j", (text, compatibility, version) => {
    expect(checkCodexVersion(text)).toEqual({ version, compatibility });
  });
});

describe("Codex probe (no model calls)", () => {
  it("runs only --version in the selected namespace and reports no credential or account fields", async () => {
    const { executor, invocations } = harness();
    const cache = readFileSync(join(profile, "auth.json"), "utf8");
    const result = await executor.probe({ profileHome: profile });
    expect(probeResultSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({
      executor: "codex",
      status: "ready",
      compatibility: "supported",
      version: "0.167.0",
      supportedRange: ">=0.167.0 <0.167.1",
    });
    expect(invocations()).toMatchObject([
      { argv: ["--version"], codexHome: profile, envKeys: ["CODEX_HOME", "PATH"], stdin: "" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/synthetic|tokens|auth_mode|profile/);
    expect(readFileSync(join(profile, "auth.json"), "utf8")).toBe(cache);
  });

  it.each(["codex-cli 0.167.1", "unrecognised version"])(
    "skips even the auth cache read for %s",
    async (versionOutput) => {
      const inspect = vi.spyOn(auth, "inspectCodexAuth");
      const { executor } = harness({ versionOutput });
      expect(await executor.probe({ profileHome: profile })).toMatchObject({
        status: "unsupported-version",
      });
      expect(inspect).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["api-key-cache.json", "unsupported-auth-mode"],
    ["mixed-cache.json", "unsupported-auth-mode"],
  ])("refuses %s", async (name, status) => {
    writeFileSync(join(profile, "auth.json"), fixture(name));
    expect(await harness().executor.probe({ profileHome: profile })).toMatchObject({ status });
  });

  it.each([
    "null",
    "[]",
    "{}",
    "synthetic-private-invalid-json",
    '{"auth_mode":"chatgpt","tokens":{}}',
    '{"auth_mode":"chatgpt","tokens":{"access_token":"","refresh_token":"synthetic"}}',
  ])("fails closed on invalid subscription cache without reflecting it: %s", async (text) => {
    writeFileSync(join(profile, "auth.json"), text);
    const result = await harness().executor.probe({ profileHome: profile });
    expect(result.status).toBe("login-required");
    expect(JSON.stringify(result)).not.toContain("synthetic");
  });

  it.each(["missing", "oversized", "symlink"])(
    "reports login-required for a %s auth cache",
    async (kind) => {
      rmSync(join(profile, "auth.json"));
      if (kind === "oversized") writeFileSync(join(profile, "auth.json"), "x".repeat(64_001));
      if (kind === "symlink") {
        const target = join(root, "synthetic-cache.json");
        writeFileSync(target, fixture("subscription-cache.json"));
        symlinkSync(target, join(profile, "auth.json"));
      }
      expect((await harness().executor.probe({ profileHome: profile })).status).toBe(
        "login-required",
      );
    },
  );

  it("reports unavailable for spawn and version-command failures", async () => {
    const absent = harness({}, join(root, "no-codex"));
    expect(await absent.executor.probe({ profileHome: profile })).toMatchObject({
      status: "unavailable",
      compatibility: "unknown",
      diagnostic: expect.stringMatching(/executable.*not found.*omi install --apply/) as unknown,
    });
    expect(
      await harness({ versionExitCode: 1 }).executor.probe({ profileHome: profile }),
    ).toMatchObject({ status: "unavailable" });
  });

  it("rejects invalid or absent profile paths without creating a profile", async () => {
    const { executor, invocations } = harness();
    for (const profileHome of ["relative", join(root, "absent")]) {
      await expect(executor.probe({ profileHome })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    }
    expect(invocations()).toEqual([]);
  });
});
