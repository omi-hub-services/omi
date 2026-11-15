import { describe, expect, it } from "vitest";
import type { ReworkCycle } from "../../../../src/domain/runs/rework-cycle.ts";
import type { StepStatus } from "../../../../src/domain/runs/step-run.ts";
import {
  buildWorkflowDiagram,
  type DiagramWorkflow,
  type Hold,
} from "../../../../src/domain/workflows/workflow-diagram.ts";
import {
  layoutWorkflowDiagram,
  type DiagramLayout,
  type LayoutBox,
} from "../../../../src/domain/workflows/workflow-diagram-layout.ts";

const step = (id: string, role: string, needs: string[] = []) => ({
  id,
  role,
  needs,
  skills: [],
  rules: [],
});
const FEATURE: DiagramWorkflow = {
  id: "feature",
  steps: [
    step("analyze", "analyst"),
    step("implement", "developer", ["analyze"]),
    step("verify", "qa", ["implement"]),
    step("review", "reviewer", ["verify"]),
  ],
  gates: [
    { id: "scope-approved", before: "implement" },
    { id: "ready-to-merge", after: "review" },
  ],
};
const UI_UX: DiagramWorkflow = {
  id: "ui-ux",
  steps: [
    step("design", "designer"),
    step("verify", "designer", ["design"]),
    step("review", "reviewer", ["verify"]),
  ],
  gates: [
    { id: "design-cost-approved", before: "design" },
    { id: "verify-cost-approved", before: "verify" },
    { id: "review-cost-approved", before: "review" },
    { id: "design-evidence", after: "design" },
    { id: "visual-evidence", after: "verify" },
    { id: "ready-to-merge", after: "review" },
  ],
};

const NONE: ReworkCycle = { phase: "before-architect", rework: 0, of: 2, architect: "none" };
const statuses = (entries: Record<string, StepStatus>) => new Map(Object.entries(entries));

function layoutOf(
  workflow: DiagramWorkflow,
  steps: Record<string, StepStatus>,
  options: { cycle?: ReworkCycle; failures?: number; hold?: Hold; atGate?: string } = {},
): DiagramLayout {
  return layoutWorkflowDiagram(
    buildWorkflowDiagram({
      workflow,
      steps: statuses(steps),
      cycle: options.cycle ?? NONE,
      failures: options.failures ?? 0,
      ...(options.hold === undefined ? {} : { hold: options.hold }),
      ...(options.atGate === undefined ? {} : { atGate: options.atGate }),
    }),
    workflow.id,
  );
}

/** Every declared label box of a diagram: template name, node text, gate captions, count plates. */
function labelBoxes(layout: DiagramLayout): LayoutBox[] {
  return [
    layout.template.box,
    ...layout.nodes.flatMap((node) => [
      node.text.box,
      ...(node.caption === undefined ? [] : [node.caption.box]),
    ]),
    ...layout.plates.map((plate) => plate.label.box),
  ];
}
interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
const PAD = 3.5; // the design's stroke/clearance padding for a connector segment
const asRect = (box: LayoutBox): Rect => ({
  x1: box.x,
  y1: box.y,
  x2: box.x + box.w,
  y2: box.y + box.h,
});
function connectorRects(layout: DiagramLayout): Rect[] {
  return layout.connectors.flatMap((connector) => {
    const parts: Rect[] = [];
    connector.points.forEach((point, index) => {
      const next = connector.points[index + 1];
      if (next === undefined) return;
      parts.push({
        x1: Math.min(point[0], next[0]) - PAD,
        y1: Math.min(point[1], next[1]) - PAD,
        x2: Math.max(point[0], next[0]) + PAD,
        y2: Math.max(point[1], next[1]) + PAD,
      });
    });
    const arrow = connector.arrow ?? [];
    if (arrow.length > 0) {
      const xs = arrow.map((point) => point[0]);
      const ys = arrow.map((point) => point[1]);
      parts.push({
        x1: Math.min(...xs),
        y1: Math.min(...ys),
        x2: Math.max(...xs),
        y2: Math.max(...ys),
      });
    }
    return parts;
  });
}
const overlap = (a: Rect, b: Rect) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
function collisions(layout: DiagramLayout): string[] {
  const labels = layout.nodes.length === 0 ? [] : labelBoxes(layout);
  const found: string[] = [];
  for (const rect of connectorRects(layout))
    for (const label of labels)
      if (overlap(rect, asRect(label))) found.push(`${label.text} @ ${JSON.stringify(rect)}`);
  return found;
}

const SCENARIOS: readonly [string, () => DiagramLayout][] = [
  ["feature straight", () => layoutOf(FEATURE, { analyze: "succeeded", implement: "running" })],
  [
    "feature rework active",
    () =>
      layoutOf(
        FEATURE,
        { analyze: "succeeded", implement: "running", verify: "succeeded", review: "failed" },
        { failures: 1, cycle: { ...NONE, rework: 1 } },
      ),
  ],
  [
    "feature rework prior",
    () =>
      layoutOf(
        FEATURE,
        { analyze: "succeeded", implement: "succeeded", verify: "succeeded", review: "running" },
        { failures: 1, cycle: { ...NONE, rework: 1 } },
      ),
  ],
  [
    "feature architect needed",
    () =>
      layoutOf(
        FEATURE,
        { analyze: "succeeded", implement: "succeeded", verify: "succeeded", review: "failed" },
        {
          failures: 2,
          cycle: { phase: "architect", rework: 2, of: 2, architect: "needed" },
        },
      ),
  ],
  [
    "feature ask PO",
    () =>
      layoutOf(
        FEATURE,
        { analyze: "succeeded", implement: "ready", review: "failed" },
        {
          failures: 4,
          cycle: { phase: "escalate-po", rework: 2, of: 2, architect: "called" },
          hold: { kind: "waiting-po" },
        },
      ),
  ],
  [
    "ui-ux waiting PO at the design evidence gate",
    () =>
      layoutOf(
        UI_UX,
        { design: "succeeded" },
        { hold: { kind: "waiting-po" }, atGate: "design-evidence" },
      ),
  ],
  [
    "ui-ux blocked with rework",
    () =>
      layoutOf(
        UI_UX,
        { design: "succeeded", verify: "succeeded", review: "failed" },
        { failures: 2, hold: { kind: "blocked", by: [7] }, cycle: { ...NONE, rework: 2 } },
      ),
  ],
];

describe("layoutWorkflowDiagram geometry", () => {
  it.each(SCENARIOS)("%s: every connector is orthogonal", (_name, build) => {
    const layout = build();
    for (const connector of layout.connectors) {
      expect(connector.points.length).toBeGreaterThanOrEqual(2);
      connector.points.forEach((point, index) => {
        const next = connector.points[index + 1];
        if (next !== undefined) expect(point[0] === next[0] || point[1] === next[1]).toBe(true);
      });
      if (connector.arrow !== undefined) expect(connector.arrow).toHaveLength(3);
      // every route ends in an arrowhead, except the first half of the split rework track
      if (connector.kind !== "return") expect(connector.arrow).toBeDefined();
    }
  });

  it.each(SCENARIOS)("%s: no connector or arrowhead touches a label", (_name, build) => {
    expect(collisions(build())).toEqual([]);
  });

  it.each(SCENARIOS)("%s: every shape stays inside the view box", (_name, build) => {
    const layout = build();
    const boxes = [
      ...labelBoxes(layout),
      ...layout.nodes.map((node) => ({ ...node.shape, text: node.id })),
    ];
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.h).toBeLessThanOrEqual(layout.height);
    }
  });

  it("the check detects a connector that crosses a label (negative control)", () => {
    const layout = layoutOf(FEATURE, { analyze: "succeeded", implement: "running" });
    const first = layout.nodes[0];
    if (first === undefined) throw new Error("no node");
    const crossing: DiagramLayout = {
      ...layout,
      connectors: [
        {
          kind: "forward",
          prior: false,
          points: [
            [first.text.box.x, first.text.box.y + 5],
            [first.text.box.x + first.text.box.w, first.text.box.y + 5],
          ],
          arrow: [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
        },
      ],
    };
    expect(collisions(crossing).length).toBeGreaterThan(0);
  });

  it("counts a rework loop only on its own plate and leaves the label unobstructed", () => {
    const layout = layoutOf(
      FEATURE,
      { analyze: "succeeded", implement: "running", review: "failed" },
      { failures: 3, cycle: { ...NONE, rework: 1 } },
    );
    expect(layout.plates).toHaveLength(1);
    expect(layout.plates[0]?.label.text).toBe("↶ 3");
    const returns = layout.connectors.filter((connector) => connector.kind === "return");
    // the track is split around the plate, and the arrow rises into the rework target
    expect(returns).toHaveLength(2);
    expect(returns.at(-1)?.arrow?.[0]?.[1]).toBeGreaterThan(returns.at(-1)?.arrow?.[1]?.[1] ?? 0);
    expect(returns[0]?.arrow).toBeUndefined();
  });

  it("marks a loop that no longer runs as prior, with the wider plate", () => {
    const layout = layoutOf(
      FEATURE,
      { analyze: "succeeded", implement: "succeeded", verify: "succeeded", review: "running" },
      { failures: 1, cycle: { ...NONE, rework: 1 } },
    );
    expect(layout.plates[0]?.label.text).toBe("↶ 1 · prior");
    expect(layout.connectors.filter((c) => c.kind === "return").every((c) => c.prior)).toBe(true);
    expect(layout.plates[0]?.box.w).toBe(104);
  });

  it("keeps the straight path short and reserves height only for real branches", () => {
    const straight = layoutOf(FEATURE, { analyze: "succeeded" });
    const rework = layoutOf(
      FEATURE,
      { analyze: "succeeded", review: "failed" },
      { failures: 1, cycle: { ...NONE, rework: 1 } },
    );
    const escalation = SCENARIOS[4]?.[1]();
    expect([straight.height, rework.height, escalation?.height]).toEqual([94, 124, 170]);
    expect(straight.width).toBe(600);
  });
});

describe("layoutWorkflowDiagram content", () => {
  it("draws exactly the template's nodes in template order, steps as rectangles and gates as diamonds", () => {
    const layout = layoutOf(UI_UX, { design: "running" });
    expect(layout.nodes.map((node) => [node.id, node.shape.kind])).toEqual([
      ["design-cost-approved", "diamond"],
      ["design", "rect"],
      ["design-evidence", "diamond"],
      ["verify-cost-approved", "diamond"],
      ["verify", "rect"],
      ["visual-evidence", "diamond"],
      ["review-cost-approved", "diamond"],
      ["review", "rect"],
      ["ready-to-merge", "diamond"],
    ]);
    expect(layout.template.text).toBe("ui-ux");
  });

  it("cues every state with a symbol and not by colour alone", () => {
    const layout = layoutOf(FEATURE, { analyze: "succeeded", implement: "running" });
    const symbols = Object.fromEntries(layout.nodes.map((node) => [node.id, node.symbol]));
    expect(symbols).toMatchObject({ analyze: "✓", implement: "▶", review: "○" });
    const blocked = layoutOf(
      FEATURE,
      { analyze: "succeeded", implement: "succeeded", verify: "ready" },
      { hold: { kind: "blocked", by: [3] } },
    );
    expect(blocked.nodes.find((node) => node.id === "verify")?.symbol).toBe("⊘");
    const failed = layoutOf(FEATURE, { analyze: "succeeded", implement: "failed" });
    expect(failed.nodes.find((node) => node.id === "implement")?.symbol).toBe("×");
    const waiting = layoutOf(FEATURE, { analyze: "succeeded" }, { hold: { kind: "waiting-po" } });
    expect(waiting.nodes.find((node) => node.state === "waiting-po")?.symbol).toBe("Ⅱ");
  });

  it("uses the short visual names and keeps the full ids in the accessible description", () => {
    const layout = layoutOf(UI_UX, { design: "succeeded" });
    const caption = (id: string) => layout.nodes.find((node) => node.id === id)?.caption?.text;
    expect(caption("design-cost-approved")).toBe("D·cost");
    expect(caption("design-evidence")).toBe("D·ev");
    expect(caption("visual-evidence")).toBe("V·ev");
    expect(caption("ready-to-merge")).toBe("Merge");
    expect(layout.description).toContain("ui-ux: design-cost-approved");
    expect(layout.description).toContain("ready-to-merge");
    const feature = layoutOf(FEATURE, { analyze: "succeeded", implement: "running" });
    expect(feature.nodes.find((node) => node.id === "implement")?.text.text).toBe("▶ Build");
    expect(feature.nodes.find((node) => node.id === "scope-approved")?.caption?.text).toBe("Scope");
  });

  it("marks exactly one node as the current one, also on an active escalation branch", () => {
    for (const [, build] of SCENARIOS) {
      const current = build().nodes.filter((node) => node.current);
      expect(current.length).toBeLessThanOrEqual(1);
    }
    const ask = SCENARIOS[4]?.[1]();
    expect(ask?.nodes.filter((node) => node.current).map((node) => node.id)).toEqual(["ask-po"]);
    const waiting = SCENARIOS[5]?.[1]();
    expect(waiting?.nodes.filter((node) => node.current).map((node) => node.id)).toEqual([
      "design-evidence",
    ]);
  });

  it("names the tone of the card from where the task stands", () => {
    expect(SCENARIOS[0]?.[1]().tone).toBe("work");
    expect(SCENARIOS[1]?.[1]().tone).toBe("rework");
    expect(SCENARIOS[3]?.[1]().tone).toBe("architect");
    expect(SCENARIOS[4]?.[1]().tone).toBe("ask");
    expect(SCENARIOS[5]?.[1]().tone).toBe("waiting");
    expect(SCENARIOS[6]?.[1]().tone).toBe("blocked");
  });

  it("describes the rework loop and the escalation branch for assistive technology", () => {
    const ask = SCENARIOS[4]?.[1]();
    expect(ask?.description).toContain("rework review returns to implement, count 4");
    expect(ask?.description).toContain("Architect");
    expect(ask?.description).toContain("Ask PO");
  });

  it("widens the view box instead of squeezing a long template", () => {
    const many: DiagramWorkflow = {
      id: "long",
      steps: Array.from({ length: 12 }, (_, i) =>
        step(`step-${String(i)}`, "developer", i === 0 ? [] : [`step-${String(i - 1)}`]),
      ),
      gates: [],
    };
    const layout = layoutOf(many, {});
    expect(layout.width).toBeGreaterThan(600);
    expect(layout.nodes.at(-1)?.shape.x ?? 0).toBeLessThanOrEqual(layout.width);
  });

  it("returns an empty layout when the template is missing", () => {
    const layout = layoutWorkflowDiagram({ nodes: [] }, null);
    expect(layout.nodes).toEqual([]);
    expect(layout.connectors).toEqual([]);
  });
});
