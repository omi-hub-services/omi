import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeQuotaReader } from "../../../src/infrastructure/executors/claude-code/claude-code-quota.ts";
import { readInvocations, writeFakeClaude } from "../executors/claude-code/fake-claude-cli.ts";

const fixtureDir = resolve(import.meta.dirname, "../../fixtures");
const usageBody = readFileSync(join(fixtureDir, "quota/claude-usage-response.json"), "utf8");
const unexpectedBody = readFileSync(
  join(fixtureDir, "quota/claude-usage-unexpected-shape.json"),
  "utf8",
);
const rateLimitEvent = readFileSync(
  join(fixtureDir, "executors/claude-code/rate-limit-allowed-recorded.jsonl"),
  "utf8",
);

const TOKEN = "fake-access-token-for-tests-only";
const NOW = Date.parse("2026-11-11T10:00:00Z");
let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omi-claude-quota-"));
  home = join(root, "profile");
  mkdirSync(home);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const profile = () => ({ profileId: "p", tool: "claude-code" as const, credentialRef: home });
function credentials(oauth: Record<string, unknown> = { accessToken: TOKEN }) {
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }));
}
interface Call {
  url: string;
  init: RequestInit;
}
function stubFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchStub = (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: href, init: init ?? {} });
    return Promise.resolve(respond());
  };
  return { fetch: fetchStub, calls };
}
const json = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

describe("Claude usage endpoint reader", () => {
  it("reads 5h, 7d and the weekly window per model, ignoring the entries that repeat them", async () => {
    credentials();
    const { fetch } = stubFetch(() => json(usageBody));
    const result = await createClaudeQuotaReader({ fetch }).read(profile(), {
      now: NOW,
      probe: false,
    });
    expect(result.note).toBeNull();
    expect(result.reading).toEqual({
      source: "claude-usage-api",
      observedAt: NOW,
      fiveHour: { usedPercent: 33, resetsAt: Date.parse("2026-11-11T11:10:00Z") },
      sevenDay: { usedPercent: 41.5, resetsAt: Date.parse("2026-11-16T07:00:00Z") },
      status: "allowed",
      limited: false,
      resetCredits: null,
      modelWindows: [
        { model: "Opus", usedPercent: 91, resetsAt: Date.parse("2026-11-16T07:00:00Z") },
      ],
    });
  });

  it("marks a reading with a full window as limited", async () => {
    credentials();
    const full = JSON.stringify({
      five_hour: { utilization: 100, resets_at: "2026-11-11T11:10:00+00:00" },
      seven_day: null,
    });
    const { fetch } = stubFetch(() => json(full));
    const { reading } = await createClaudeQuotaReader({ fetch }).read(profile(), {
      now: NOW,
      probe: false,
    });
    expect(reading).toMatchObject({ limited: true, status: "rejected" });
  });

  it("sends the token only to the usage endpoint, without following redirects", async () => {
    credentials();
    const { fetch, calls } = stubFetch(() => json(usageBody));
    await createClaudeQuotaReader({ fetch }).read(profile(), { now: NOW, probe: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "anthropic-beta": "oauth-2025-04-20",
    });
  });

  it("never lets the token or unknown response keys reach the reading or the note", async () => {
    credentials();
    const leaky = stubFetch(() => {
      throw new Error(`connect failed for Bearer ${TOKEN}`);
    });
    const failed = await createClaudeQuotaReader({ fetch: leaky.fetch }).read(profile(), {
      now: NOW,
      probe: false,
    });
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
    const ok = stubFetch(() => json(usageBody));
    const read = await createClaudeQuotaReader({ fetch: ok.fetch }).read(profile(), {
      now: NOW,
      probe: false,
    });
    expect(JSON.stringify(read)).not.toContain("unknown_future_key");
    expect(JSON.stringify(read)).not.toContain(TOKEN);
  });

  it("does not write into the profile directory", async () => {
    credentials();
    const before = readFileSync(join(home, ".credentials.json"), "utf8");
    const { fetch } = stubFetch(() => json(usageBody, 401));
    await createClaudeQuotaReader({ fetch }).read(profile(), { now: NOW, probe: false });
    expect(readFileSync(join(home, ".credentials.json"), "utf8")).toBe(before);
  });
});

describe("Claude usage failures and fallback", () => {
  const failures: [string, () => void, () => Response | Promise<Response>, string, boolean][] = [
    [
      "no credential file",
      () => undefined,
      () => json(usageBody),
      "no readable credentials",
      false,
    ],
    [
      "no access token",
      () => {
        credentials({ accessToken: "" });
      },
      () => json(usageBody),
      "no access token",
      false,
    ],
    [
      "expired token",
      () => {
        credentials({ accessToken: TOKEN, expiresAt: NOW - 1 });
      },
      () => json(usageBody),
      "token expired",
      false,
    ],
    [
      "HTTP error",
      () => {
        credentials();
      },
      () => json("{}", 401),
      "HTTP 401",
      true,
    ],
    [
      "timeout",
      () => {
        credentials();
      },
      () => {
        throw Object.assign(new Error("slow"), { name: "TimeoutError" });
      },
      "timeout",
      true,
    ],
    [
      "network error",
      () => {
        credentials();
      },
      () => {
        throw new Error("ECONNRESET");
      },
      "network error",
      true,
    ],
    [
      "non-JSON body",
      () => {
        credentials();
      },
      () => json("<html>"),
      "response is not JSON",
      true,
    ],
    [
      "array body",
      () => {
        credentials();
      },
      () => json("[]"),
      "unexpected response shape",
      true,
    ],
    [
      "shape the parser rejects",
      () => {
        credentials();
      },
      () => json(unexpectedBody),
      "unexpected response shape",
      true,
    ],
  ];
  it.each(failures)(
    "reports %s as a reason and no reading",
    async (_n, arrange, respond, note, calls) => {
      arrange();
      const stub = stubFetch(respond);
      const result = await createClaudeQuotaReader({ fetch: stub.fetch }).read(profile(), {
        now: NOW,
        probe: false,
      });
      expect(result).toEqual({ reading: null, note });
      expect(stub.calls.length > 0).toBe(calls);
    },
  );

  it("falls back to the last good reading and keeps its original age", async () => {
    credentials();
    let status = 200;
    const stub = stubFetch(() => json(status === 200 ? usageBody : "{}", status));
    const reader = createClaudeQuotaReader({ fetch: stub.fetch, minIntervalMs: 1000 });
    const first = await reader.read(profile(), { now: NOW, probe: false });
    status = 401;
    const later = NOW + 3 * 3_600_000;
    const second = await reader.read(profile(), { now: later, probe: false });
    expect(second.note).toBe("HTTP 401");
    expect(second.reading).toEqual(first.reading);
    expect(second.reading?.observedAt).toBe(NOW);
  });

  it("does not call the endpoint again inside the minimum interval", async () => {
    credentials();
    const stub = stubFetch(() => json(usageBody));
    const reader = createClaudeQuotaReader({ fetch: stub.fetch, minIntervalMs: 300_000 });
    const first = await reader.read(profile(), { now: NOW, probe: false });
    const again = await reader.read(profile(), { now: NOW + 60_000, probe: false });
    expect(stub.calls).toHaveLength(1);
    expect(again.reading).toEqual(first.reading);
    await reader.read(profile(), { now: NOW + 300_000, probe: false });
    expect(stub.calls).toHaveLength(2);
  });

  it("honours Retry-After after HTTP 429 and keeps serving the cached reading", async () => {
    credentials();
    let limited = false;
    const stub = stubFetch(() =>
      limited ? json("{}", 429, { "retry-after": "1200" }) : json(usageBody),
    );
    const reader = createClaudeQuotaReader({ fetch: stub.fetch, minIntervalMs: 1000 });
    const first = await reader.read(profile(), { now: NOW, probe: false });
    limited = true;
    const blocked = await reader.read(profile(), { now: NOW + 2000, probe: false });
    expect(blocked.note).toBe("HTTP 429");
    expect(blocked.reading).toEqual(first.reading);
    const calls = stub.calls.length;
    await reader.read(profile(), { now: NOW + 600_000, probe: false });
    expect(stub.calls).toHaveLength(calls);
    await reader.read(profile(), { now: NOW + 1_300_000, probe: false });
    expect(stub.calls).toHaveLength(calls + 1);
  });
});

describe("Claude probe", () => {
  function probeReader(scenario: { stdout: string; exitCode?: number }) {
    const record = join(root, "record.jsonl");
    const executable = writeFakeClaude(root, "claude", scenario, record);
    const stub = stubFetch(() => json(usageBody));
    const reader = createClaudeQuotaReader({
      fetch: stub.fetch,
      probe: {
        executable,
        parentEnv: { PATH: process.env["PATH"] ?? "", ANTHROPIC_API_KEY: "must-not-pass" },
      },
    });
    return { reader, record };
  }

  it("runs one minimal Haiku call on the profile and reads the rate_limit_event", async () => {
    credentials();
    const { reader, record } = probeReader({ stdout: rateLimitEvent });
    const { reading } = await reader.read(profile(), { now: NOW, probe: true });
    expect(reading).toMatchObject({
      source: "claude-probe",
      fiveHour: { usedPercent: 10, resetsAt: 1794395400 * 1000 },
      sevenDay: { usedPercent: 68, resetsAt: 1794387600 * 1000 },
      limited: false,
      observedAt: NOW,
    });
    const runs = readInvocations(record);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.argv).toEqual(
      expect.arrayContaining(["-p", "--model", "haiku", "--max-turns", "1", "--tools", ""]),
    );
    expect(runs[0]?.claudeConfigDir).toBe(home);
    expect(runs[0]?.envKeys).not.toContain("ANTHROPIC_API_KEY");
  });

  it("keeps the model windows of the last usage reading, which a probe does not report", async () => {
    credentials();
    const { reader } = probeReader({ stdout: rateLimitEvent });
    await reader.read(profile(), { now: NOW, probe: false });
    const { reading } = await reader.read(profile(), { now: NOW + 1000, probe: true });
    expect(reading?.source).toBe("claude-probe");
    expect(reading?.modelWindows.map((w) => w.model)).toEqual(["Opus"]);
  });

  it("falls back with a reason when the probe prints no rate_limit_event", async () => {
    const { reader } = probeReader({ stdout: '{"type":"result"}\n' });
    const result = await reader.read(profile(), { now: NOW, probe: true });
    expect(result).toEqual({ reading: null, note: "probe returned no rate_limit_event" });
  });

  describe("expired token (OMI-094)", () => {
    const expired = () => {
      credentials({ accessToken: TOKEN, expiresAt: NOW - 8 * 3_600_000 });
    };

    it("probes once, shows the probe reading with the reason, and never loops", async () => {
      expired();
      const { reader, record } = probeReader({ stdout: rateLimitEvent });
      const first = await reader.read(profile(), { now: NOW, probe: false });
      expect(first.note).toBe("token expired");
      expect(first.reading?.source).toBe("claude-probe");
      expect(readInvocations(record)).toHaveLength(1);
      const later = await reader.read(profile(), { now: NOW + 10 * 3_600_000, probe: false });
      expect(later.note).toBe("token expired");
      expect(later.reading?.source).toBe("claude-probe");
      expect(readInvocations(record)).toHaveLength(1);
    });

    it("reads usage after a probe that renewed the token", async () => {
      expired();
      const record = join(root, "renewing.jsonl");
      const executable = join(root, "claude-renewing");
      const renewed = JSON.stringify({
        claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW + 3_600_000 },
      });
      writeFileSync(
        executable,
        `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(record)}, "run\\n");\nfs.writeFileSync(require("node:path").join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), ${JSON.stringify(renewed)});\nprocess.stdin.resume();\nprocess.stdin.on("end", () => console.log(${JSON.stringify(rateLimitEvent.split("\n")[0] ?? "")}));\n`,
        { mode: 0o700 },
      );
      const stub = stubFetch(() => json(usageBody));
      const reader = createClaudeQuotaReader({
        fetch: stub.fetch,
        probe: { executable, parentEnv: { PATH: process.env["PATH"] ?? "" } },
      });
      const result = await reader.read(profile(), { now: NOW, probe: false });
      expect(result.note).toBeNull();
      expect(result.reading?.source).toBe("claude-usage-api");
      expect(stub.calls).toHaveLength(1);
      expect(readFileSync(record, "utf8").trim().split("\n")).toHaveLength(1);
    });

    it("does not probe while the token is valid", async () => {
      credentials({ accessToken: TOKEN, expiresAt: NOW + 3_600_000 });
      const { reader, record } = probeReader({ stdout: rateLimitEvent });
      await reader.read(profile(), { now: NOW, probe: false });
      expect(readInvocations(record)).toHaveLength(0);
    });
  });

  it("does nothing extra when no probe is configured", async () => {
    credentials();
    const stub = stubFetch(() => json(usageBody));
    const result = await createClaudeQuotaReader({ fetch: stub.fetch }).read(profile(), {
      now: NOW,
      probe: true,
    });
    expect(result.reading?.source).toBe("claude-usage-api");
  });
});
