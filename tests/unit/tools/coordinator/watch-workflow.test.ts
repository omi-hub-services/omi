import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Step } from "../../../../tools/coordinator/watch-tasks.ts";
import {
  loadTemplate,
  mapTemplatePos,
  standingOf,
  workStepId,
  type TemplatePos,
} from "../../../../tools/coordinator/watch-workflow.ts";

const ok = async (id: string) => {
  const read = await loadTemplate(id);
  if (!read.ok) throw new Error(read.reason);
  return read.workflow;
};

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

describe("standingOf: template position -> the runtime's step statuses", () => {
  const stand = async (
    pos: TemplatePos,
    over: { running?: boolean; fails?: number; architect?: boolean; id?: string } = {},
  ) =>
    standingOf({
      workflow: await ok(over.id ?? "feature"),
      pos,
      running: over.running ?? false,
      fails: over.fails ?? 0,
      architect: over.architect ?? false,
    });
  const at = (id: string): TemplatePos => ({ kind: "node", id });

  it("marks the steps before the position done and the position running while a worker runs", async () => {
    const s = await stand(at("verify"), { running: true });
    expect(Object.fromEntries(s.steps)).toEqual({
      analyze: "succeeded",
      implement: "succeeded",
      verify: "running",
    });
    expect(s.atGate).toBeUndefined();
  });

  it("makes the position ready, not running, when no worker runs", async () => {
    expect(Object.fromEntries((await stand(at("implement"))).steps)).toEqual({
      analyze: "succeeded",
      implement: "ready",
    });
  });

  it("stands before the developer step at Start: the analysts are done, nothing is current yet", async () => {
    expect(Object.fromEntries((await stand({ kind: "before" })).steps)).toEqual({
      analyze: "succeeded",
    });
  });

  it("stands at a gate: every step before it is done and the gate is where the task stands", async () => {
    const s = await stand(at("ready-to-merge"));
    expect(Object.fromEntries(s.steps)).toEqual({
      analyze: "succeeded",
      implement: "succeeded",
      verify: "succeeded",
      review: "succeeded",
    });
    expect(s.atGate).toBe("ready-to-merge");
  });

  it("finishes every step when the task is done, and none when the position is unknown", async () => {
    const done = await stand({ kind: "done" });
    expect([...done.steps.values()].every((status) => status === "succeeded")).toBe(true);
    expect(done.steps.size).toBe(4);
    expect((await stand({ kind: "unknown", reason: "x" })).steps.size).toBe(0);
  });

  it("shows the review failed while rework runs before it, and not once the work is back at review", async () => {
    const rework = await stand(at("implement"), { running: true, fails: 1 });
    expect(rework.steps.get("review")).toBe("failed");
    const again = await stand(at("review"), { running: true, fails: 1 });
    expect(again.steps.get("review")).toBe("running");
    const noFail = await stand(at("implement"), { running: true, fails: 0 });
    expect(noFail.steps.has("review")).toBe(false);
  });

  it("makes the review failed when the Architect is the next call", async () => {
    const s = await stand(at("review"), { fails: 2, architect: true });
    expect(s.steps.get("review")).toBe("failed");
    expect(s.steps.get("verify")).toBe("succeeded");
  });

  it("keeps ui-ux gates around its three designer and reviewer steps", async () => {
    const s = await stand(at("design-evidence"), { id: "ui-ux" });
    expect(Object.fromEntries(s.steps)).toEqual({ design: "succeeded" });
    expect(s.atGate).toBe("design-evidence");
  });
});
