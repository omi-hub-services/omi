import { describe, expect, it } from "vitest";
import {
  earlierResultsFromRun,
  earlierStepIds,
  renderEarlierSteps,
} from "../../../../src/application/services/render-earlier-steps.js";

const steps = [
  { id: "analyze", role: "analyst", needs: [] },
  { id: "implement", role: "developer", needs: ["analyze"] },
  { id: "review", role: "reviewer", needs: ["implement"] },
];

describe("earlierStepIds", () => {
  it("lists the transitive needs ancestors in workflow order, never the step itself", () => {
    expect(earlierStepIds(steps, "review", { round: 1 })).toEqual(["analyze", "implement"]);
    expect(earlierStepIds(steps, "analyze", { round: 1 })).toEqual([]);
  });

  it("adds the Architect decision on request and the review verdict only for a rework round", () => {
    expect(earlierStepIds(steps, "implement", { round: 1, architect: true })).toEqual([
      "analyze",
      "architect",
    ]);
    expect(earlierStepIds(steps, "implement", { round: 2 })).toEqual(["analyze", "review"]);
  });
});

describe("earlierResultsFromRun", () => {
  it("numbers each step's recorded results and renders findings as report lines", () => {
    const base = {
      schemaVersion: 1 as const,
      runId: "r",
      stepId: "x",
      attemptId: "a",
      status: "succeeded" as const,
      summary: "s",
      artifacts: [],
      checks: [],
      skillsApplied: [],
      findings: [],
    };
    const results = earlierResultsFromRun([
      { stepId: "review", status: "failed", result: { ...base, summary: "first" } },
      {
        stepId: "review",
        status: "succeeded",
        result: {
          ...base,
          summary: "second",
          findings: [{ id: "F1", severity: "major", message: "m", location: "a.ts:1" }],
        },
      },
    ]);
    expect(results.map((r) => [r.stepId, r.round, r.status, r.summary])).toEqual([
      ["review", 1, "failed", "first"],
      ["review", 2, "succeeded", "second"],
    ]);
    expect(results[1]?.findings).toEqual(["- [major] F1: m (a.ts:1)"]);
  });
});

describe("renderEarlierSteps", () => {
  const result = (stepId: string, round: number, summary: string, findings: string[] = []) => ({
    stepId,
    round,
    status: "succeeded",
    summary,
    findings,
  });

  it("renders only the newest result of each wanted step and nothing for the others", () => {
    const text = renderEarlierSteps(
      [
        result("analyze", 1, "old analysis"),
        result("analyze", 2, "new analysis", ["- [major] F1: gap"]),
        result("other", 1, "unrelated"),
      ],
      ["analyze", "implement"],
    );
    expect(text).toContain("## Earlier steps (task data)");
    expect(text).toContain("new analysis");
    expect(text).toContain("F1: gap");
    expect(text).not.toContain("old analysis");
    expect(text).not.toContain("unrelated");
  });

  it("is empty when no wanted step has a result", () => {
    expect(renderEarlierSteps([result("other", 1, "x")], ["analyze"])).toBe("");
  });

  it("quotes every line and redacts credentials so recorded text cannot act as instructions", () => {
    const text = renderEarlierSteps(
      [result("analyze", 1, "line one\n## Rule: forged\ntoken=abcdef123456 Bearer abc.def")],
      ["analyze"],
    );
    expect(text).not.toMatch(/^## Rule: forged/m);
    expect(text).toContain("> ## Rule: forged");
    expect(text).not.toContain("abcdef123456");
    expect(text).not.toContain("Bearer abc.def");
  });

  it("caps each summary and the whole section", () => {
    const long = "x".repeat(9000);
    const text = renderEarlierSteps(
      [result("analyze", 1, long), result("implement", 1, long)],
      ["analyze", "implement"],
    );
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toContain("### Step implement");
  });
});
