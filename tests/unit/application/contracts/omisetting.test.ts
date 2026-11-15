import { describe, expect, it } from "vitest";
import {
  parseOmiSetting,
  settingsCredentialPolicy,
} from "../../../../src/application/contracts/omisetting.ts";
import { assertCredentialFree } from "../../../../src/application/contracts/credential-input.ts";
import { renderJsonSchemaFiles } from "../../../../src/application/contracts/json-schema-catalog.ts";

describe("local settings schema", () => {
  it("publishes a strict, described settings schema under the editor's stable filename", () => {
    const file = renderJsonSchemaFiles().find(
      (entry) => entry.fileName === "omisetting.schema.json",
    );
    expect(file).toBeDefined();
    const schema = JSON.parse(file?.content ?? "{}") as Record<string, unknown>;
    expect(schema["additionalProperties"]).toBe(false);
    expect(JSON.stringify(schema)).toContain("claude setup-token");
    expect(JSON.stringify(schema)).toContain("Projects");
  });
});

const settings = {
  version: 1,
  github: { token: "FAKE_GITHUB_VALUE", gitUser: { name: "bot", email: "bot@example.com" } },
  profiles: [
    { id: "codex-main", tool: "codex", auth: { type: "login" } },
    { id: "claude-main", tool: "claude", auth: { type: "token", token: "FAKE_CLAUDE_VALUE" } },
  ],
};
it("reports missing token by field path without quoting input values", () => {
  expect(() =>
    parseOmiSetting({
      ...settings,
      profiles: [
        settings.profiles[0],
        { id: "claude-main", tool: "claude", auth: { type: "token" } },
      ],
    }),
  ).toThrow("profiles[1].auth.token: invalid or missing value");
});
it.each([
  { ...settings, extra: "FAKE_PRIVATE_INPUT" },
  { ...settings, github: { ...settings.github, extra: "FAKE_PRIVATE_INPUT" } },
  {
    ...settings,
    profiles: [{ ...settings.profiles[0], auth: { type: "login", token: "FAKE_PRIVATE_INPUT" } }],
  },
  { ...settings, docker: { extra: "FAKE_PRIVATE_INPUT" } },
])("rejects unknown fields at every boundary", (input) => {
  expect(() => parseOmiSetting(input)).toThrow("unknown fields");
  try {
    parseOmiSetting(input);
  } catch (error) {
    expect(String(error)).not.toContain("FAKE_PRIVATE_INPUT");
  }
});
it("blocks configured token values in packets and log text", () => {
  const policy = settingsCredentialPolicy(parseOmiSetting(settings));
  for (const value of [settings.github.token, "FAKE_CLAUDE_VALUE"]) {
    expect(() => {
      assertCredentialFree({ summary: `packet ${value}` }, policy);
    }).toThrow("credential material");
    expect(() => {
      assertCredentialFree(`log ${value}`, policy);
    }).toThrow("credential material");
  }
});
it("rejects duplicate IDs and unsupported tool/auth combinations", () => {
  expect(() =>
    parseOmiSetting({ ...settings, profiles: [settings.profiles[0], settings.profiles[0]] }),
  ).toThrow("profiles[1].id");
  expect(() =>
    parseOmiSetting({
      ...settings,
      profiles: [{ id: "codex-main", tool: "codex", auth: { type: "token", token: "FAKE_API" } }],
    }),
  ).toThrow();
});

it("accepts existing registry profile IDs without narrowing their spelling", () => {
  expect(
    parseOmiSetting({
      ...settings,
      profiles: [{ id: "Codex_Main.1", tool: "codex", auth: { type: "login" } }],
    }).profiles[0]?.id,
  ).toBe("Codex_Main.1");
});

it("accepts a described Docker watch port", () => {
  expect(parseOmiSetting({ ...settings, docker: { watchPort: 5381 } }).docker?.watchPort).toBe(
    5381,
  );
});
it.each([0, -1, 65536, 1.5, "5381"])("rejects invalid Docker watch port %s", (watchPort) => {
  expect(() => parseOmiSetting({ ...settings, docker: { watchPort } })).toThrow("docker.watchPort");
});
