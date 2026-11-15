import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodexQuotaReader } from "../../../src/infrastructure/executors/codex/codex-quota.ts";
import {
  quotaFixture,
  readAppServerInvocations,
  writeFakeAppServer,
  type FakeAppServerScenario,
} from "./fake-codex-app-server.ts";

const NOW = Date.parse("2026-11-11T10:00:00Z");
let root: string;
let home: string;
let record: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omi-codex-quota-"));
  home = join(root, "profile");
  mkdirSync(home);
  record = join(root, "record.jsonl");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const profile = () => ({ profileId: "p", tool: "codex" as const, credentialRef: home });
function reader(scenario: FakeAppServerScenario, timeoutMs = 10_000, name = "codex") {
  return createCodexQuotaReader({
    executable: writeFakeAppServer(root, name, scenario, record),
    parentEnv: {
      PATH: process.env["PATH"] ?? "",
      OPENAI_API_KEY: "must-not-pass",
      CODEX_HOME: "/wrong/profile",
    },
    timeoutMs,
  });
}

describe("Codex app-server quota reader", () => {
  it("reads the 5h and 7d windows and the reset credits left", async () => {
    const result = await reader({ result: quotaFixture("codex-rate-limits.json") }).read(
      profile(),
      { now: NOW, probe: false },
    );
    expect(result).toEqual({
      note: null,
      reading: {
        source: "codex-app-server",
        observedAt: NOW,
        fiveHour: { usedPercent: 12, resetsAt: 1794310800 * 1000 },
        sevenDay: { usedPercent: 99, resetsAt: 1794657600 * 1000 },
        status: "allowed",
        limited: false,
        resetCredits: 2,
        modelWindows: [],
      },
    });
  });

  it("reports a reached limit as limited", async () => {
    const { reading } = await reader({
      result: quotaFixture("codex-rate-limit-reached.json"),
    }).read(profile(), { now: NOW, probe: false });
    expect(reading).toMatchObject({ limited: true, status: "primary", resetCredits: 1 });
  });

  it("starts app-server on the profile's own home with a clean environment", async () => {
    await reader({ result: quotaFixture("codex-rate-limits.json") }).read(profile(), {
      now: NOW,
      probe: false,
    });
    const [run] = readAppServerInvocations(record);
    expect(run?.argv).toEqual(["app-server"]);
    expect(run?.codexHome).toBe(home);
    expect(run?.envKeys).not.toContain("OPENAI_API_KEY");
  });

  it("only reads: it never asks for anything that could spend a reset credit", async () => {
    await reader({ result: quotaFixture("codex-rate-limits.json") }).read(profile(), {
      now: NOW,
      probe: false,
    });
    const methods = readAppServerInvocations(record).flatMap((run) => run.methods);
    expect(new Set(methods)).toEqual(
      new Set(["initialize", "initialized", "account/rateLimits/read"]),
    );
  });

  it("needs no probe: a probe request reads the same free way", async () => {
    const result = await reader({ result: quotaFixture("codex-rate-limits.json") }).read(
      profile(),
      { now: NOW, probe: true },
    );
    expect(result.reading?.source).toBe("codex-app-server");
  });
});

describe("Codex failures and fallback", () => {
  const cases: [string, FakeAppServerScenario, number, string][] = [
    ["an RPC error", { behaviour: "rpc-error" }, 10_000, "account/rateLimits/read failed"],
    [
      "an exit before the result",
      { behaviour: "exit-before-result" },
      10_000,
      "codex app-server exited without a result",
    ],
    ["a hang", { behaviour: "hang" }, 300, "codex app-server timed out"],
    [
      "a result of the wrong shape",
      { result: { unexpected: true } },
      10_000,
      "unexpected response shape",
    ],
  ];
  it.each(cases)("reports %s as a reason and no reading", async (_n, scenario, timeout, note) => {
    const result = await reader(scenario, timeout).read(profile(), { now: NOW, probe: false });
    expect(result).toEqual({ reading: null, note });
  });

  it("reports a missing executable as a reason", async () => {
    const result = await createCodexQuotaReader({
      executable: join(root, "does-not-exist"),
      parentEnv: { PATH: "" },
    }).read(profile(), { now: NOW, probe: false });
    expect(result).toEqual({ reading: null, note: "codex could not start" });
  });

  it("falls back to the last good reading and keeps its original age", async () => {
    const good = writeFakeAppServer(
      root,
      "good",
      { result: quotaFixture("codex-rate-limits.json") },
      record,
    );
    const bad = writeFakeAppServer(root, "bad", { behaviour: "rpc-error" }, record);
    let executable = good;
    const sut = createCodexQuotaReader({
      get executable() {
        return executable;
      },
      parentEnv: { PATH: process.env["PATH"] ?? "" },
    });
    const first = await sut.read(profile(), { now: NOW, probe: false });
    executable = bad;
    const later = NOW + 5 * 3_600_000;
    const second = await sut.read(profile(), { now: later, probe: false });
    expect(second.note).toBe("account/rateLimits/read failed");
    expect(second.reading).toEqual(first.reading);
    expect(second.reading?.observedAt).toBe(NOW);
  });
});
