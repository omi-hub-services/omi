import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareLoaded,
  loadTemplate,
  mapTemplatePos,
  orderNodes,
  templateNodes,
  workStepId,
} from "../../../../tools/coordinator/watch-workflow.ts";
import { cyclePhase, type Step } from "../../../../tools/coordinator/watch-tasks.ts";

const ok = async (id: string) => {
  const read = await loadTemplate(id);
  if (!read.ok) throw new Error(read.reason);
  return read.workflow;
};
const none = cyclePhase([]);
const ids = (w: Awaited<ReturnType<typeof ok>>) => orderNodes(w).map((n) => n.id);

describe("loadTemplate", () => {
  it("parses the shipped templates with the workflow schema", async () => {
    for (const id of ["feature", "bugfix", "docs", "refactor", "ui-ux"]) {
      expect((await loadTemplate(id)).ok).toBe(true);
    }
  });

  it("returns a reason for an unknown, malformed or path-like workflow id", async () => {
    const missing = await loadTemplate("nope");
    expect(missing).toMatchObject({ ok: false });
    expect(missing.ok ? "" : missing.reason).toContain("nope");
    for (const bad of ["../feature", "", "a/b", "Feature X"]) {
      const r = await loadTemplate(bad);
      expect(r.ok).toBe(false);
    }
  });

  it("reads from the directory it is given and reports invalid YAML or schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omi-wf-"));
    writeFileSync(join(dir, "broken.yaml"), "id: [unclosed");
    writeFileSync(join(dir, "empty.yaml"), "schema_version: 1\nid: empty\n");
    expect((await loadTemplate("broken", dir)).ok).toBe(false);
    expect((await loadTemplate("empty", dir)).ok).toBe(false);
  });
});

describe("orderNodes: steps by needs, gates around them", () => {
  it("feature: analyze, scope-approved, implement, verify, review, ready-to-merge", async () => {
    expect(ids(await ok("feature"))).toEqual([
      "analyze",
      "scope-approved",
      "implement",
      "verify",
      "review",
      "ready-to-merge",
    ]);
  });

  it("bugfix: reproduce, scope-approved, implement, verify, regression-test, review, ready-to-merge", async () => {
    expect(ids(await ok("bugfix"))).toEqual([
      "reproduce",
      "scope-approved",
      "implement",
      "verify",
      "regression-test",
      "review",
      "ready-to-merge",
    ]);
  });

  it("docs has no analyze/implement: write, verify, accept and its own gates", async () => {
    expect(ids(await ok("docs"))).toEqual([
      "scope-approved",
      "write",
      "verify",
      "accept",
      "docs-acceptance",
      "ready-to-merge",
    ]);
  });

  it("carries role, skills and rules of each step and marks gates", async () => {
    const nodes = orderNodes(await ok("feature"));
    expect(nodes.find((n) => n.id === "implement")).toMatchObject({
      kind: "step",
      role: "developer",
      skills: ["test-driven-development", "minimal-change"],
    });
    expect(nodes.find((n) => n.id === "ready-to-merge")).toMatchObject({ kind: "gate" });
  });
});

describe("mapTemplatePos (observed lifecycle step -> template step)", () => {
  const pos = async (id: string, step: Step) => mapTemplatePos(await ok(id), step);

  it("feature: Start before work, Work implement, Verify/PR verify, Review review", async () => {
    expect(await pos("feature", "Start")).toEqual({ kind: "before" });
    expect(await pos("feature", "Work")).toEqual({ kind: "node", id: "implement" });
    expect(await pos("feature", "Rework")).toEqual({ kind: "node", id: "implement" });
    expect(await pos("feature", "Verify/PR")).toEqual({ kind: "node", id: "verify" });
    expect(await pos("feature", "Review")).toEqual({ kind: "node", id: "review" });
    expect(await pos("feature", "Architect")).toEqual({ kind: "node", id: "review" });
    expect(await pos("feature", "Merge")).toEqual({ kind: "node", id: "ready-to-merge" });
    expect(await pos("feature", "Done")).toEqual({ kind: "done" });
  });

  it("docs follows its own steps: write, verify, accept", async () => {
    expect(await pos("docs", "Work")).toEqual({ kind: "node", id: "write" });
    expect(await pos("docs", "Review")).toEqual({ kind: "node", id: "accept" });
  });

  it("bugfix: two developer steps run in one worker; the last one is shown", async () => {
    expect(await pos("bugfix", "Work")).toEqual({ kind: "node", id: "implement" });
    expect(workStepId(await ok("bugfix"))).toBe("implement");
  });

  it("unknown (with a reason) when the template has no matching step or the step is unknown", async () => {
    const w = await ok("feature");
    const noQa = { ...w, steps: w.steps.filter((s) => s.role !== "qa") };
    expect(mapTemplatePos(noQa, "Verify/PR")).toMatchObject({ kind: "unknown" });
    const noMerge = { ...w, gates: [] };
    const r = mapTemplatePos(noMerge, "Merge");
    expect(r.kind === "unknown" ? r.reason : "").toContain("ready-to-merge");
    expect(mapTemplatePos(w, "unknown")).toMatchObject({ kind: "unknown" });
  });
});

describe("templateNodes", () => {
  const states = (nodes: ReturnType<typeof templateNodes>) =>
    Object.fromEntries(nodes.map((n) => [n.id, n.state]));

  it("marks earlier nodes done, the current one current, later ones todo", async () => {
    const w = await ok("feature");
    const nodes = templateNodes(w, { kind: "node", id: "verify" }, none);
    expect(states(nodes)).toEqual({
      analyze: "done",
      "scope-approved": "done",
      implement: "done",
      verify: "current",
      review: "todo",
      "ready-to-merge": "todo",
    });
    expect(nodes.find((n) => n.id === "verify")).toMatchObject({ role: "qa", sub: "qa" });
  });

  it("before: analysis and scope gate are done, the work step is not started", async () => {
    const s = states(templateNodes(await ok("feature"), { kind: "before" }, none));
    expect(s).toMatchObject({ "scope-approved": "done", implement: "todo", analyze: "done" });
  });

  it("done marks every node done; unknown marks none current", async () => {
    const w = await ok("docs");
    expect(
      Object.values(states(templateNodes(w, { kind: "done" }, none))).every((s) => s === "done"),
    ).toBe(true);
    const u = templateNodes(w, { kind: "unknown", reason: "x" }, none);
    expect(u.some((n) => n.state === "current")).toBe(false);
  });

  it("rework: the work step is current with rework k/2 and Architect is added from the 2nd FAIL", async () => {
    const w = await ok("feature");
    const cycle = cyclePhase([]);
    const n1 = templateNodes(w, { kind: "node", id: "implement" }, cycle, undefined, "rework 1/2");
    expect(n1.find((n) => n.id === "implement")).toMatchObject({
      state: "current",
      sub: "rework 1/2",
    });
    const arch = templateNodes(
      w,
      { kind: "node", id: "review" },
      { ...cycle, phase: "architect", fails: 2, k: 2 },
      undefined,
    );
    expect(arch.map((n) => n.id)).toContain("Architect");
  });

  it("Architect as the step: review is done, Architect current", async () => {
    const w = await ok("feature");
    const cycle = { phase: "architect", fails: 2, k: 2, architectCalled: true } as const;
    const nodes = templateNodes(
      w,
      { kind: "node", id: "review" },
      cycle,
      undefined,
      undefined,
      true,
    );
    expect(states(nodes)).toMatchObject({ review: "done", Architect: "current" });
  });

  it("Blocked / Waiting PO: the node the task stands at is blocked with the sub-label", async () => {
    const w = await ok("feature");
    const nodes = templateNodes(w, { kind: "node", id: "implement" }, none, "waiting PO");
    expect(nodes.find((n) => n.id === "implement")).toMatchObject({
      state: "blocked",
      sub: "waiting PO",
    });
    expect(nodes.find((n) => n.id === "analyze")?.state).toBe("done");
  });
});

describe("compareLoaded (skills actually loaded vs the template step)", () => {
  const compare = async (loaded: string[]) => {
    const c = compareLoaded(await ok("feature"), "implement", loaded);
    if (!c) throw new Error("implement is a step");
    return c;
  };

  it("marks a loaded skill that the template assigns to another step, and a missing one", async () => {
    const c = await compare(["test-driven-development", "verification-before-completion"]);
    expect(c.expected).toEqual(["test-driven-development", "minimal-change"]);
    expect(c.missing).toEqual(["minimal-change"]);
    expect(c.extra).toEqual([{ name: "verification-before-completion", template: "verify" }]);
  });

  it("an extra skill the template never uses has template null; an exact match is clean", async () => {
    const extra = (await compare(["test-driven-development", "minimal-change", "zzz"])).extra;
    expect(extra).toEqual([{ name: "zzz", template: null }]);
    const c = await compare(["minimal-change", "test-driven-development"]);
    expect(c.missing).toEqual([]);
    expect(c.extra).toEqual([]);
  });

  it("is null for a gate or an unknown step id", async () => {
    const w = await ok("feature");
    expect(compareLoaded(w, "ready-to-merge", [])).toBeNull();
    expect(compareLoaded(w, "nope", [])).toBeNull();
  });
});
