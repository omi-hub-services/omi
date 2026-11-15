import { describe, expect, it } from "vitest";
import {
  subscriptionAuthMode,
  validateResult,
} from "../../../live/codex-cli/codex-worker-result.js";

describe("Codex structured result and auth boundary", () => {
  it("requires every declared field and rejects extra fields or wrong types", () => {
    expect(validateResult('{"codename":"sample","changedFiles":[]}')).toEqual({
      codename: "sample",
      changedFiles: [],
    });
    for (const text of [
      "null",
      "[]",
      "{}",
      '{"codename":"sample","changedFiles":[5]}',
      '{"codename":"sample","changedFiles":[],"extra":"untrusted"}',
    ]) {
      expect(() => validateResult(text)).toThrow("Codex result violates output schema");
    }
  });
  it("never includes malformed JSON or validation input in thrown errors", () => {
    expect(() => validateResult("synthetic-secret")).toThrow(
      /^invalid JSON at Codex PoC boundary$/,
    );
    expect(() => subscriptionAuthMode("synthetic-secret")).toThrow(
      /^invalid JSON at Codex PoC boundary$/,
    );
  });
  it("reports only the auth mode and rejects missing tokens, API auth and mixed credentials", () => {
    const auth = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" },
    };
    expect(subscriptionAuthMode(JSON.stringify(auth))).toBe("chatgpt");
    for (const input of [
      {},
      { ...auth, auth_mode: "apikey" },
      { ...auth, OPENAI_API_KEY: "synthetic-key" },
      { ...auth, tokens: {} },
      { ...auth, tokens: { access_token: "", refresh_token: "synthetic" } },
    ]) {
      expect(() => subscriptionAuthMode(JSON.stringify(input))).toThrow(
        /^profile must contain subscription auth without an API key$/,
      );
    }
  });
});
