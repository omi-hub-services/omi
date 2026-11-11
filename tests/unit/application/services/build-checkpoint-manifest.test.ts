import { createHash } from "node:crypto";
import { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import { CredentialInputError } from "../../../../src/application/contracts/credential-input.ts";
import { buildCheckpointManifest } from "../../../../src/application/services/build-checkpoint-manifest.ts";

const hasher = { sha256: (text: string) => createHash("sha256").update(text).digest("hex") };
const h = (c: string): string => c.repeat(64);
const T = "2026-11-11T00:00:00.000Z";

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    checkpointId: "cp-1",
    kind: "before-dispatch",
    createdAt: T,
    runId: "run-1",
    stepRunId: "step-1",
    stepId: "implement",
    hashes: {
      config: h("1"),
      template: h("2"),
      skills: [{ id: "tdd", version: "1", sha256: h("a") }],
      rules: [{ id: "architecture-boundaries", version: "1", sha256: h("b") }],
    },
    taskSnapshot: { issueNumber: 31, title: "Business checkpoint", body: "Do it." },
    acceptanceCriteria: ["manifest has counters"],
    businessBaselineHash: h("9"),
    counters: { reworkCount: 1, retryCount: 0, qualityCycle: 2 },
    decisions: [{ id: "use-two-phase", summary: "Pending row first." }],
    approvalRefs: ["approval-1"],
    outputs: [{ path: "attempts/a1/report.md", sha256: h("c"), size: 4 }],
    git: { worktreePath: "/work/omi-026", headSha: "a".repeat(40), branch: "task/x", dirty: true },
    uncommitted: {
      entries: [{ path: "src/a.ts", status: "modified", staged: false, sha256: h("d"), size: 10 }],
      truncated: false,
      excludedCredentialPaths: 0,
    },
    previousFindings: [{ id: "f-1", severity: "minor", message: "Rename." }],
    nextAction: { action: "dispatch-step", stepId: "review" },
    ...overrides,
  };
}

describe("buildCheckpointManifest", () => {
  it("covers every field architecture §10 lists", () => {
    const { manifest } = buildCheckpointManifest(hasher, candidate());
    expect(Object.keys(manifest).sort()).toEqual(
      [
        "schemaVersion",
        "checkpointId",
        "kind",
        "createdAt",
        "runId",
        "stepRunId",
        "stepId",
        "hashes",
        "taskSnapshot",
        "acceptanceCriteria",
        "businessBaselineHash",
        "counters",
        "decisions",
        "approvalRefs",
        "outputs",
        "git",
        "uncommitted",
        "previousFindings",
        "nextAction",
      ].sort(),
    );
    expect(manifest.counters).toEqual({ reworkCount: 1, retryCount: 0, qualityCycle: 2 });
    expect(manifest.git.headSha).toBe("a".repeat(40));
    expect(manifest.uncommitted.entries[0]?.path).toBe("src/a.ts");
  });

  it("is deterministic: key order of the input does not change the bytes or the hash", () => {
    const a = buildCheckpointManifest(hasher, candidate());
    const reordered = Object.fromEntries(Object.entries(candidate()).reverse());
    const b = buildCheckpointManifest(hasher, reordered);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toBe(createHash("sha256").update(a.bytes).digest("hex"));
  });

  it.each([
    ["an unknown schema version", { schemaVersion: 2 }],
    ["an unknown kind", { kind: "whenever" }],
    ["a negative counter", { counters: { reworkCount: -1 } }],
    ["a bad git sha", { git: { worktreePath: "/w", headSha: "abc", branch: null, dirty: false } }],
    ["an unexpected extra field", { extra: true }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => buildCheckpointManifest(hasher, candidate(overrides))).toThrow(ZodError);
  });

  describe("credentials (ADR-0022)", () => {
    it.each([
      [
        "a token in the task text",
        { taskSnapshot: { issueNumber: 1, title: "t", body: "ghp_abcdefghijklmnop1234" } },
      ],
      ["a credential key", { counters: { token: 1 } }],
      [
        "a credential file path",
        { decisions: [{ id: "d", summary: "see /home/u/.aws/credentials" }] },
      ],
      ["a secret assignment", { decisions: [{ id: "d", summary: "password = hunter2hunter2" }] }],
    ])("refuses %s instead of redacting it", (_name, overrides) => {
      expect(() => buildCheckpointManifest(hasher, candidate(overrides))).toThrow(
        CredentialInputError,
      );
    });

    it("refuses a caller-known secret value anywhere in the manifest", () => {
      expect(() =>
        buildCheckpointManifest(
          hasher,
          candidate({ nextAction: { action: "retry", note: "uses s3cr3t-value-xyz" } }),
          { sensitiveValues: ["s3cr3t-value-xyz"] },
        ),
      ).toThrow(CredentialInputError);
    });
  });
});
