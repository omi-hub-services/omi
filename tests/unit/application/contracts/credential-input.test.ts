import { describe, expect, it } from "vitest";
import {
  assertCredentialFree,
  CredentialInputError,
} from "../../../../src/application/contracts/credential-input.ts";

describe("credential guard", () => {
  it.each([
    ".env",
    "config/.env.production",
    ".aws/credentials",
    ".ssh/id_ed25519",
    ".claude/settings.json",
    ".codex/config.toml",
    ".claude-profiles/work/settings.json",
    ".codex-profiles/work/config.toml",
    "${CLAUDE_CONFIG_DIR}/settings.json",
    "$CODEX_HOME/auth.json",
    "auth.json",
    "config/credentials.json",
    "~/.codex/auth.json",
    ".credentials.json",
    "profiles/credentials",
    "C:\\Users\\tester\\.codex\\auth.json",
    ".config/gh/hosts.yml",
    ".netrc",
    ".npmrc",
    ".git-credentials",
    ".omi-squad/local/credentials/profile/settings.json",
    ".omi-squad/local/profiles/registry.json",
  ])("rejects credential path %s", (path) => {
    expect(() => {
      assertCredentialFree(path);
    }).toThrow(CredentialInputError);
  });

  it.each([
    "sk-proj-syntheticTestValue",
    "ghp_syntheticTestValue",
    "github_pat_syntheticTestValue",
    "Authorization: Bearer synthetic-test-value",
    '"refresh_token": "synthetic"',
    "eyJsynthetic.payload.signature",
    "-----BEGIN PRIVATE KEY-----",
    "GITHUB_TOKEN=ghp_syntheticTestValue",
    "OPENAI_API_KEY=sk-syntheticTestValue",
    "CUSTOM_SERVICE_SECRET=synthetic-value",
    "AKIA0000000000000000",
    "xoxb-synthetic-test-value",
    "glpat-synthetic-test-value",
    "https://u:p@host",
    "api_key: synthetic-value",
    "password = synthetic-value",
  ])("rejects synthetic credential-like value %j", (text) => {
    expect(() => {
      assertCredentialFree(text);
    }).toThrow(CredentialInputError);
  });

  it.each([
    "env",
    "environment",
    "process.env",
    "accessToken",
    "refresh_token",
    "apiKey",
    "password",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
  ])("rejects nested field %s", (key) => {
    expect(() => {
      assertCredentialFree({ inputs: [{ [key]: "synthetic" }] });
    }).toThrow(CredentialInputError);
  });

  it("checks keys as well as values, including paths used as object keys", () => {
    expect(() => {
      assertCredentialFree({ "config/.env": "synthetic" });
    }).toThrow(CredentialInputError);
  });

  it("accepts normal packet metadata, source summaries and hashes", () => {
    expect(() => {
      assertCredentialFree({
        summary: "Atomic writes verified. See analysis/input.md.",
        source: { path: "analysis/input.md", sha256: "a".repeat(64) },
        version: "1",
        id: "minimal-change",
        paths: ["src/", "tests/"],
      });
    }).not.toThrow();
  });

  it.each([
    "const x = 5;\nif (a == b) { return x; }",
    '<div class="x">Artifact evidence</div>',
    "## Acceptance criteria\n- Atomic writes\n<!-- omi-squad:plan-key=OMI-012 -->",
    "Handle credentials locally; never include credentials in a report.",
    "NODE_ENV=production\nMAX_TOKENS=4096\nversion=1\nkey=OMI-012",
    '{"usage":{"max_tokens":4096,"tokenCount":123}}',
  ])("accepts realistic nonsecret text %j", (text) => {
    expect(() => {
      assertCredentialFree(text);
    }).not.toThrow();
  });

  it("accepts usage and tokenization JSON fields without accepting secret field names", () => {
    expect(() => {
      assertCredentialFree({
        max_tokens: 4096,
        tokenCount: 123,
        tokenizer: "example",
        secretCount: 0,
      });
    }).not.toThrow();
    expect(() => {
      assertCredentialFree({ refresh_token: "synthetic" });
    }).toThrow(CredentialInputError);
  });

  it("supports known opaque values and custom profile directories without echoing them", () => {
    const policy = {
      sensitiveValues: ["synthetic-opaque-value"],
      credentialRoots: ["/custom/login"],
    };
    expect(() => {
      assertCredentialFree("summary synthetic-opaque-value", policy);
    }).toThrow(CredentialInputError);
    expect(() => {
      assertCredentialFree("/custom/login/settings.toml", policy);
    }).toThrow(CredentialInputError);
    expect(() => {
      assertCredentialFree("safe", { sensitiveValues: [""], credentialRoots: [""] });
    }).not.toThrow();
  });
});
