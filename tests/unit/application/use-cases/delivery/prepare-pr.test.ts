import { describe, expect, it } from "vitest";
import { preparePr } from "../../../../../src/application/use-cases/delivery/prepare-pr.ts";
import { preparationHarness, request } from "./prepare-pr-fakes.ts";

describe("preparePr", () => {
  it("creates into develop, lists every AC with evidence, verifies backlink and mapping, and reuses on retry", async () => {
    const h = preparationHarness();
    expect(await preparePr(h.deps, request)).toMatchObject({
      status: "verified",
      mapping: { issueNumber: 26, prNumber: 100, taskId: "task-26" },
    });
    expect(h.state.pull?.body).toContain("Issue: #26");
    expect(h.state.pull?.body).toContain(
      "AC-1: First criterion\nEvidence: unit suite\nAC-2: Second criterion\nEvidence: contract suite",
    );
    expect(h.state.pull?.base).toBe("develop");
    expect(h.state.pull?.body).not.toMatch(/\bCloses\b/i);
    expect(h.state.backlink).toContain("https://github.com/acme/app/pull/100");
    await preparePr(h.deps, request);
    expect(h.github.sends).toHaveLength(2);
  });
  it.each(["no AC section", "## Acceptance criteria\n  - [ ] nested\n### Notes\n- [ ] excluded"])(
    "refuses missing/empty criteria before a write: %s",
    async (body) => {
      const h = preparationHarness();
      h.state.issueBody = body;
      await expect(preparePr(h.deps, request)).rejects.toThrow("AC_SECTION_EMPTY_OR_MISSING");
      expect(h.github.sends).toHaveLength(0);
      expect(h.outbox.records.size).toBe(0);
    },
  );
  it("requires nonempty evidence for every criterion", async () => {
    const h = preparationHarness();
    await expect(preparePr(h.deps, { ...request, evidence: ["one"] })).rejects.toThrow(
      "AC_EVIDENCE_MISMATCH",
    );
    await expect(preparePr(h.deps, { ...request, evidence: ["", "two"] })).rejects.toThrow();
    expect(h.github.sends).toHaveLength(0);
  });
  it("refuses closing references supplied through Issue data or evidence", async () => {
    const h = preparationHarness();
    await expect(
      preparePr(h.deps, { ...request, evidence: ["Closes #26", "two"] }),
    ).rejects.toThrow("CLOSING_REFERENCE_FORBIDDEN");
    expect(h.github.sends).toHaveLength(0);
  });
  it("refuses an unrelated existing PR without creating or overwriting it", async () => {
    const h = preparationHarness();
    h.state.pull = {
      number: 99,
      repository: "acme/app",
      head: request.head,
      base: "develop",
      body: "other task",
      state: "open",
    };
    await expect(preparePr(h.deps, request)).rejects.toThrow("PR_VERIFICATION_FAILED");
    expect(h.github.sends).toHaveLength(0);
  });
  it("does not report success when backlink read-back fails", async () => {
    const h = preparationHarness();
    h.deps.reader.hasBacklink = () => Promise.resolve(false);
    await expect(preparePr(h.deps, request)).rejects.toThrow("BACKLINK_VERIFICATION_FAILED");
    expect(h.state.mapping).toBeUndefined();
  });
  it("does not report success when local read-back differs", async () => {
    const h = preparationHarness();
    h.deps.mappings.save = () => undefined;
    await expect(preparePr(h.deps, request)).rejects.toThrow("MAPPING_VERIFICATION_FAILED");
  });
  it("keeps unknown writes pending instead of resending them immediately", async () => {
    const h = preparationHarness();
    h.github.onSend = () => undefined;
    h.github.sendScript = [{ kind: "outcome_unknown", code: "TIMEOUT" }];
    expect(await preparePr(h.deps, request)).toMatchObject({
      status: "pending",
      state: "outcome_unknown",
    });
    expect(await preparePr(h.deps, request)).toMatchObject({
      status: "pending",
      state: "outcome_unknown",
    });
    expect(h.github.sends).toHaveLength(1);
  });
});
