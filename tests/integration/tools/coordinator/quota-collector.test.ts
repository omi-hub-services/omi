// Runs the quota collector (quota.ts REMOTE_COLLECTOR) with real Node against a temp $HOME, the
// way the WSL payload runs it: source on stdin, argv after `-`.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REMOTE_COLLECTOR } from "../../../../tools/coordinator/quota.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runCollector(
  home: string,
  targets: string[] = [],
  preload?: string,
  mode = "",
  options: { probe?: boolean | "expired"; now?: number } = {},
) {
  const loader = preload ? ["--import", preload] : [];
  const probe = options.probe === "expired" ? "expired" : options.probe ? "1" : "0";
  return spawnSync(
    process.execPath,
    [...loader, "--input-type=module", "-", "omi-runs", probe, ...targets],
    {
      input: REMOTE_COLLECTOR,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FAKE_FETCH: mode,
        FAKE_NOW: String(options.now ?? ""),
        PATH: `${join(home, "bin")}:${process.env.PATH ?? ""}`,
      },
      timeout: 30_000,
    },
  );
}

const TOKEN = "sk-ant-oat01-FAKE-token-for-tests-only";
const USAGE_BODY = {
  five_hour: { utilization: 33, resets_at: "2026-11-11T11:10:00+00:00", extra: "x" },
  seven_day: { utilization: 41.5, resets_at: "2026-11-16T07:00:00+00:00" },
  account: { email: "someone@example.com", uuid: "acct-secret" },
  limits: [
    {
      kind: "weekly_scoped",
      percent: 1,
      resets_at: "2026-11-16T07:00:00+00:00",
      scope: { model: { display_name: "Fable", id: "m-secret" } },
    },
  ],
};

/** A temp HOME with one profile credential file and a preload that replaces fetch. */
function usageSetup(expiresAt: number | null) {
  const home = mkdtempSync(join(tmpdir(), "omi-usage-"));
  dirs.push(home);
  const profile = join(home, ".claude-profiles", "p1");
  mkdirSync(profile, { recursive: true });
  const oauth: Record<string, unknown> = { accessToken: TOKEN, refreshToken: "refresh-FAKE" };
  if (expiresAt !== null) oauth.expiresAt = expiresAt;
  const credPath = join(profile, ".credentials.json");
  writeFileSync(credPath, JSON.stringify({ claudeAiOauth: oauth }));
  const seen = join(home, "seen.json");
  const preload = join(home, "fetch-stub.mjs");
  writeFileSync(
    preload,
    `import { writeFileSync, appendFileSync } from "node:fs";
if (process.env.FAKE_NOW) Date.now = () => Number(process.env.FAKE_NOW) * 1000;
globalThis.fetch = async (url, init) => {
  const mode = process.env.FAKE_FETCH;
  if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 100));
  appendFileSync(${JSON.stringify(join(home, "calls"))}, "call\\n");
  if (mode === "429") return { ok: false, status: 429, headers: { get: () => "900" } };
  if (mode === "bad") return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: "bad" } }) };
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ url: String(url), auth: init.headers.Authorization, beta: init.headers["anthropic-beta"], redirect: init.redirect }));
  if (mode === "throw") throw new Error("connect failed to sk-ant-oat01-FAKE-token-for-tests-only");
  if (mode === "timeout") { const e = new Error("t"); e.name = "TimeoutError"; throw e; }
  if (mode === "401") return { ok: false, status: 401, json: async () => ({}) };
  if (mode === "html") return { ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } };
  if (mode === "array") return { ok: true, status: 200, json: async () => [] };
  return { ok: true, status: 200, json: async () => (${JSON.stringify(USAGE_BODY)}) };
};
`,
  );
  return { home, preload, seen, credPath };
}

const parsed = (stdout: string) =>
  stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((o) => o.kind !== "now");

describe("quota collector", () => {
  it.skipIf(process.platform === "win32")(
    "skips a log that vanishes between readdir and stat instead of crashing",
    () => {
      const home = mkdtempSync(join(tmpdir(), "omi-quota-"));
      dirs.push(home);
      const runs = join(home, "omi-runs");
      mkdirSync(runs);
      const event = { type: "rate_limit_event", rate_limit_info: { status: "allowed" } };
      writeFileSync(
        join(runs, "omi-052-ggtintran-20261110-120000.jsonl"),
        `${JSON.stringify(event)}\n`,
      );
      // A dangling symlink is listed by readdir but fails stat, like a log deleted in between.
      symlinkSync(join(runs, "gone.jsonl"), join(runs, "omi-051-minibox-20261110-110000.jsonl"));

      const result = runCollector(home);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const kinds = result.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { kind: string; file?: string });
      expect(kinds.map((k) => [k.kind, k.file])).toEqual([
        ["now", undefined],
        ["log", "omi-052-ggtintran-20261110-120000.jsonl"],
      ]);
    },
  );

  describe("claude usage endpoint", () => {
    const run = (expiresAt: number | null, mode = "") => {
      const setup = usageSetup(expiresAt);
      const result = runCollector(setup.home, ["claude:p1"], setup.preload, mode);
      return { ...setup, result };
    };
    const future = () => Date.now() + 3_600_000;

    it("calls only api.anthropic.com with the bearer token and emits trimmed fields", () => {
      const { result, seen } = run(future());
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({
        url: "https://api.anthropic.com/api/oauth/usage",
        auth: `Bearer ${TOKEN}`,
        beta: "oauth-2025-04-20",
        redirect: "error",
      });
      expect(parsed(result.stdout)).toEqual([
        {
          kind: "usage",
          profile: "p1",
          usage: {
            five_hour: { utilization: 33, resets_at: "2026-11-11T11:10:00+00:00" },
            seven_day: { utilization: 41.5, resets_at: "2026-11-16T07:00:00+00:00" },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 1,
                resets_at: "2026-11-16T07:00:00+00:00",
                model: "Fable",
              },
            ],
          },
        },
      ]);
    });

    it("does not call the endpoint for an expired token, and does not touch the profile dir", () => {
      const { result, seen, credPath } = run(Date.now() - 1000);
      expect(parsed(result.stdout)).toEqual([
        { kind: "expired", profile: "p1", expiresAt: expect.any(Number) as number },
        { kind: "error", tool: "claude-usage", profile: "p1", message: "token expired" },
      ]);
      expect(existsSync(seen)).toBe(false);
      expect(readFileSync(credPath, "utf8")).toContain(TOKEN);
    });

    it.each([
      ["401", "HTTP 401"],
      ["throw", "network error"],
      ["timeout", "timeout"],
      ["html", "response is not JSON"],
      ["array", "unexpected response shape"],
    ])("reports only the error kind for %s", (mode, message) => {
      const { result } = run(future(), mode);
      expect(parsed(result.stdout)).toEqual([
        { kind: "error", tool: "claude-usage", profile: "p1", message },
      ]);
    });

    it("never prints the token or anything outside the whitelisted fields", () => {
      for (const mode of ["", "401", "throw", "timeout", "html", "array"]) {
        const { result } = run(future(), mode);
        const all = result.stdout + result.stderr;
        expect(all).not.toContain(TOKEN);
        expect(all).not.toContain("refresh-FAKE");
        expect(all).not.toMatch(/example\.com|acct-secret|m-secret|accessToken/);
      }
    });

    it("reports a profile without credentials", () => {
      const home = mkdtempSync(join(tmpdir(), "omi-usage-"));
      dirs.push(home);
      const result = runCollector(home, ["claude:nobody"]);
      expect(parsed(result.stdout)).toEqual([
        {
          kind: "error",
          tool: "claude-usage",
          profile: "nobody",
          message: "no readable credentials",
        },
      ]);
    });
  });
});

describe("Claude collector shared cache", () => {
  const now = 1794390000;
  const collect = (
    setup: ReturnType<typeof usageSetup>,
    at: number,
    mode = "",
    probe: boolean | "expired" = false,
  ) => {
    const result = runCollector(setup.home, ["claude:p1"], setup.preload, mode, { now: at, probe });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    return parsed(result.stdout);
  };
  const cache = (home: string) =>
    JSON.parse(readFileSync(join(home, "omi-runs", ".quota-cache.json"), "utf8")) as Record<
      string,
      {
        reading: { source: string; observedAt: number; modelWindows: unknown[] };
        nextAllowedAt: number;
      }
    >;

  it("persists good API data, spaces calls across collector processes, and backs off on 429", () => {
    const setup = usageSetup((now + 10000) * 1000);
    expect(collect(setup, now)[0]?.kind).toBe("usage");
    const good = cache(setup.home).p1?.reading;
    expect(good).toMatchObject({ source: "claude-usage-api", observedAt: now });
    expect(collect(setup, now + 299, "429")).toEqual([
      { kind: "cache", profile: "p1", reading: good },
    ]);
    expect(collect(setup, now + 300, "429")).toEqual([
      { kind: "error", tool: "claude-usage", profile: "p1", message: "HTTP 429" },
      { kind: "cache", profile: "p1", reading: good },
    ]);
    expect(cache(setup.home).p1?.nextAllowedAt).toBe(now + 1200);
    expect(collect(setup, now + 1199)[0]).toEqual({ kind: "cache", profile: "p1", reading: good });
    expect(collect(setup, now + 1200)[0]?.kind).toBe("usage");
    expect(readFileSync(join(setup.home, "calls"), "utf8").trim().split("\n")).toHaveLength(3);
    expect(cache(setup.home).p1?.reading.observedAt).toBe(now + 1200);
    const contents = readFileSync(join(setup.home, "omi-runs", ".quota-cache.json"), "utf8");
    expect(contents).not.toMatch(/FAKE|example.com|acct-secret|accessToken|refreshToken/);
  });

  it("reserves concurrent calls and preserves simultaneous writes for different profiles", async () => {
    const setup = usageSetup(Date.now() + 3_600_000);
    const run = (profile: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            setup.preload,
            "--input-type=module",
            "-",
            "omi-runs",
            "0",
            `claude:${profile}`,
          ],
          {
            env: {
              ...process.env,
              HOME: setup.home,
              USERPROFILE: setup.home,
              FAKE_NOW: "",
              FAKE_FETCH: "slow",
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stderr = "";
        child.stdout.resume();
        child.stderr.on("data", (part: Buffer) => {
          stderr += part.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0 || stderr)
            reject(new Error(`collector exited ${String(code)}: ${stderr}`));
          else resolve();
        });
        child.stdin.end(REMOTE_COLLECTOR);
      });
    await Promise.all([run("p1"), run("p1")]);
    expect(readFileSync(join(setup.home, "calls"), "utf8").trim().split("\n")).toHaveLength(1);
    // Force another eligible round, now with two independent profiles writing the same cache.
    const path = join(setup.home, "omi-runs", ".quota-cache.json");
    writeFileSync(path, "{}");
    const second = join(setup.home, ".claude-profiles", "p2");
    mkdirSync(second);
    writeFileSync(join(second, ".credentials.json"), readFileSync(setup.credPath));
    await Promise.all([run("p1"), run("p2")]);
    expect(Object.keys(cache(setup.home)).sort()).toEqual(["p1", "p2"]);
    expect(cache(setup.home).p1?.reading.source).toBe("claude-usage-api");
    expect(cache(setup.home).p2?.reading.source).toBe("claude-usage-api");
  });

  it("does not replace a good reading with malformed endpoint data", () => {
    const setup = usageSetup((now + 10000) * 1000);
    collect(setup, now);
    const good = cache(setup.home).p1?.reading;
    expect(collect(setup, now + 300, "bad")).toEqual([
      { kind: "error", tool: "claude-usage", profile: "p1", message: "unexpected response shape" },
      { kind: "cache", profile: "p1", reading: good },
    ]);
    expect(cache(setup.home).p1?.reading).toEqual(good);
  });

  it("updates the cache from a fake paid probe even during endpoint backoff", () => {
    const setup = usageSetup((now + 10000) * 1000);
    collect(setup, now);
    collect(setup, now + 300, "429");
    const bin = join(setup.home, "bin");
    mkdirSync(bin);
    const fake = join(bin, "claude");
    const event = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {
          five_hour: { utilization: 0.29, resetsAt: now + 3600 },
          seven_day: { utilization: 0.49, resetsAt: now + 86400 },
        },
      },
      sensitive: "never-forward",
    };
    writeFileSync(
      fake,
      `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(JSON.stringify(event))}));\n`,
    );
    chmodSync(fake, 0o700);
    const result = collect(setup, now + 400, "429", true);
    expect(result.at(-1)).toMatchObject({
      kind: "probe-reading",
      reading: {
        source: "claude-probe",
        observedAt: now + 400,
        fiveHour: { usedPercent: 29 },
        sevenDay: { usedPercent: 49 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("never-forward");
    const good = cache(setup.home).p1?.reading;
    expect(good?.source).toBe("claude-probe");
    expect(good?.modelWindows).toHaveLength(1);
    expect(cache(setup.home).p1?.nextAllowedAt).toBe(now + 1200);
    expect(collect(setup, now + 500)).toEqual([{ kind: "cache", profile: "p1", reading: good }]);
  });
});

describe("Claude collector expiry probe (OMI-094)", () => {
  const now = 1794390000;
  const expiredAt = (now - 8 * 3600) * 1000;
  const renewedAt = (now + 10_000) * 1000;
  const event = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.29, resetsAt: now + 3600 },
        seven_day: { utilization: 0.49, resetsAt: now + 86400 },
      },
    },
  };

  /** A fake `claude`; `renew` makes it rewrite the credentials the way the real CLI does. */
  function fakeClaude(home: string, renew: boolean): void {
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const creds = "require('node:path').join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json')";
    const renewed = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: renewedAt } });
    const script = [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(join(home, "claude-runs"))}, 'run\\n');`,
      renew ? `fs.writeFileSync(${creds}, ${JSON.stringify(renewed)});` : "",
      `process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(JSON.stringify(event))}));`,
    ].join("\n");
    writeFileSync(join(bin, "claude"), script);
    chmodSync(join(bin, "claude"), 0o700);
  }
  const runs = (home: string) =>
    existsSync(join(home, "claude-runs"))
      ? readFileSync(join(home, "claude-runs"), "utf8").split("\n").filter(Boolean).length
      : 0;
  const collect = (
    setup: ReturnType<typeof usageSetup>,
    at: number,
    probe: boolean | "expired",
  ) => {
    const result = runCollector(setup.home, ["claude:p1"], setup.preload, "", { now: at, probe });
    expect(result.status).toBe(0);
    return parsed(result.stdout);
  };
  const kinds = (lines: Record<string, unknown>[]) => lines.map((l) => l.kind);

  it("never probes without the expiry mode: status and pick-profile only report", () => {
    const setup = usageSetup(expiredAt);
    fakeClaude(setup.home, true);
    const out = collect(setup, now, false);
    expect(kinds(out)).toEqual(["expired", "error"]);
    expect(runs(setup.home)).toBe(0);
  });

  it("probes an expired token once, reads usage again and reports it fresh", () => {
    const setup = usageSetup(expiredAt);
    fakeClaude(setup.home, true);
    const out = collect(setup, now, "expired");
    expect(kinds(out)).toEqual(["usage"]);
    expect(runs(setup.home)).toBe(1);
    // a later poll with the renewed token neither probes nor reports expiry
    expect(kinds(collect(setup, now + 400, "expired"))).not.toContain("expired");
    expect(runs(setup.home)).toBe(1);
  });

  it("does not probe again for the same expiry when the probe did not renew the token", () => {
    const setup = usageSetup(expiredAt);
    fakeClaude(setup.home, false);
    const first = collect(setup, now, "expired");
    expect(first).toContainEqual({ kind: "expired", profile: "p1", expiresAt: expiredAt });
    expect(first).toContainEqual({
      kind: "error",
      tool: "claude-usage",
      profile: "p1",
      message: "token expired",
    });
    expect(runs(setup.home)).toBe(1);
    // well past the cooldown and the call spacing: still no second probe for this expiry
    const later = collect(setup, now + 10_000, "expired");
    expect(kinds(later)).toContain("expired");
    expect(runs(setup.home)).toBe(1);
  });

  it("does not probe inside the cooldown of an earlier probe, even a manual one", () => {
    const setup = usageSetup((now + 10_000) * 1000);
    fakeClaude(setup.home, false);
    collect(setup, now, true);
    expect(runs(setup.home)).toBe(1);
    writeFileSync(
      setup.credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: (now + 500) * 1000 } }),
    );
    expect(kinds(collect(setup, now + 600, "expired"))).toContain("expired");
    expect(runs(setup.home)).toBe(1);
  });
});
