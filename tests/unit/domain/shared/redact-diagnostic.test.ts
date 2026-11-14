import { describe, expect, it } from "vitest";
import { redactDiagnostic } from "../../../../src/domain/shared/redact-diagnostic.ts";

describe("redactDiagnostic", () => {
  it("keeps git SHA hex (40 and 64 chars) so a diagnosis can name the revision", () => {
    const sha1 = "a".repeat(20) + "0123456789".repeat(2);
    const sha256 = "0123456789abcdef".repeat(4);
    expect(redactDiagnostic("head " + sha1 + " base " + sha256, 500)).toBe(
      "head " + sha1 + " base " + sha256,
    );
  });

  it("still redacts secret-prefixed and long mixed tokens", () => {
    const text = redactDiagnostic(
      [
        "ghp_" + "A1b2".repeat(10),
        "gho_" + "x".repeat(40),
        "sk-" + "k".repeat(30),
        "Zz9_".repeat(12),
      ].join(" "),
      500,
    );
    expect(text).not.toMatch(/ghp_|gho_|sk-|Zz9_/);
  });

  it("redacts a hex run that is longer than a SHA", () => {
    expect(redactDiagnostic("f".repeat(80), 500)).toBe("[REDACTED_LONG_TOKEN]");
  });
});
