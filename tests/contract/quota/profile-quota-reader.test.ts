import { describe, expect, it } from "vitest";
import type { QuotaReader } from "../../../src/application/ports/quota-reader.ts";
import { createProfileQuotaReader } from "../../../src/infrastructure/profiles/profile-quota-reader.ts";

const stub = (label: string): QuotaReader => ({
  read: () => Promise.resolve({ reading: null, note: label }),
});
const ref = (tool: "claude-code" | "codex") => ({
  profileId: "p",
  tool,
  credentialRef: "/profiles/p",
});

describe("profile quota reader", () => {
  it("routes each profile to the reader of its own tool", async () => {
    const reader = createProfileQuotaReader({
      "claude-code": stub("claude"),
      codex: stub("codex"),
    });
    const options = { now: 1, probe: false };
    expect((await reader.read(ref("claude-code"), options)).note).toBe("claude");
    expect((await reader.read(ref("codex"), options)).note).toBe("codex");
  });
});
