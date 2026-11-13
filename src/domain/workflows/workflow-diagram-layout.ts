import type { DiagramNode, NodeState, WorkflowDiagram } from "./workflow-diagram.js";

/**
 * The geometry of one task's lifecycle diagram (approved design: docs/design/watch). Pure: the
 * diagram comes in, coordinates and label boxes go out, so a unit test can check that no connector
 * runs through a label and the browser page only draws what it is given. Every connector is made of
 * horizontal and vertical segments plus a triangle arrowhead; there are no curves.
 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
/** A declared text box: the space its label takes, used for the overlap check. */
export interface LayoutBox extends Rect {
  readonly text: string;
}
export interface LayoutLabel {
  readonly text: string;
  /** Anchor point of the text (`middle`: its centre, `start`: its left end). */
  readonly x: number;
  readonly y: number;
  /** The width the text is fitted to (SVG `textLength`). */
  readonly textLength: number;
  readonly anchor: "start" | "middle";
  readonly box: LayoutBox;
}
export type Point = readonly [number, number];
export interface LayoutNode {
  readonly id: string;
  readonly kind: DiagramNode["kind"];
  readonly state: NodeState;
  /** CSS class suffix: the state, or `escalation` / `ask` for the branch nodes. */
  readonly cls: string;
  /** The non-colour cue of the state. */
  readonly symbol: string;
  readonly shape: Rect & { readonly kind: "rect" | "diamond" };
  /** Step and branch nodes: symbol and short name; gates: the symbol alone. */
  readonly text: LayoutLabel;
  /** Gates only: the short name under the diamond. */
  readonly caption?: LayoutLabel;
  /** The one node the task stands at (`aria-current="step"`). */
  readonly current: boolean;
}
export interface LayoutConnector {
  readonly kind: "forward" | "return" | "branch" | "ask";
  /** A rework loop that no longer runs (drawn dashed). */
  readonly prior: boolean;
  readonly points: readonly Point[];
  /** The triangle arrowhead at the last point; its tip is the second point. Absent mid-route. */
  readonly arrow?: readonly [Point, Point, Point];
}
export interface LayoutPlate {
  readonly box: Rect;
  readonly label: LayoutLabel;
}
export type CardTone = "work" | "rework" | "waiting" | "blocked" | "architect" | "ask";
export interface DiagramLayout {
  readonly width: number;
  readonly height: number;
  readonly tone: CardTone;
  readonly template: LayoutLabel;
  readonly nodes: readonly LayoutNode[];
  readonly connectors: readonly LayoutConnector[];
  readonly plates: readonly LayoutPlate[];
  /** Full ids and states in template order, for the SVG's accessible name. */
  readonly description: string;
}

const MIN_WIDTH = 600;
const MARGIN = 18;
const ROW = 48;
const STEP_W = 88;
const STEP_H = 40;
const GATE = 26;
const GATE_H = 30;
const GAP = 18;
const TRACK_Y = 104;
const BRANCH_Y = 96;
const ESCALATION_Y = 145;

const SYMBOLS: Record<NodeState, string> = {
  done: "✓",
  current: "▶",
  todo: "○",
  failed: "×",
  "waiting-po": "Ⅱ",
  blocked: "⊘",
  skipped: "–",
};
const STATE_WORDS: Record<NodeState, string> = {
  done: "done",
  current: "current",
  todo: "pending",
  failed: "failed",
  "waiting-po": "waiting PO",
  blocked: "blocked",
  skipped: "skipped",
};
const STEP_NAMES: Record<string, string> = { implement: "Build" };
const GATE_NAMES: Record<string, string> = { "scope-approved": "Scope", "ready-to-merge": "Merge" };

const capitalised = (id: string) => `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
const shorten = (text: string, max: number) =>
  Array.from(text).length <= max
    ? text
    : `${Array.from(text)
        .slice(0, max - 1)
        .join("")}…`;
const initial = (id: string) => id.charAt(0).toUpperCase();

function gateCaption(id: string): string {
  const named = GATE_NAMES[id];
  if (named !== undefined) return named;
  if (id.endsWith("-cost-approved")) return `${initial(id)}·cost`;
  if (id.endsWith("-evidence")) return `${initial(id)}·ev`;
  return shorten(capitalised(id), 6);
}

function label(
  text: string,
  x: number,
  y: number,
  textLength: number,
  anchor: "start" | "middle",
  boxHeight: number,
): LayoutLabel {
  const w = textLength + 4;
  return {
    text,
    x,
    y,
    textLength,
    anchor,
    box: { text, x: anchor === "middle" ? x - w / 2 : x, y: y - boxHeight / 2, w, h: boxHeight },
  };
}
const fitted = (text: string, perChar: number, max: number) =>
  Math.min(max, Math.round(perChar * Array.from(text).length));

const EMPTY: DiagramLayout = {
  width: MIN_WIDTH,
  height: 0,
  tone: "work",
  template: label("", 8, 12, 0, "start", 20),
  nodes: [],
  connectors: [],
  plates: [],
  description: "",
};

function currentNodeId(nodes: readonly DiagramNode[]): string | undefined {
  const byState = (states: readonly NodeState[]) =>
    nodes.find((node) => states.includes(node.state))?.id;
  return (
    nodes.find((node) => node.kind === "ask-po")?.id ??
    nodes.find((node) => node.kind === "architect" && node.state === "current")?.id ??
    byState(["blocked", "waiting-po"]) ??
    byState(["current"]) ??
    byState(["failed"]) ??
    nodes.find((node) => node.kind === "step" && node.state === "todo")?.id
  );
}

function toneOf(nodes: readonly DiagramNode[], reworkActive: boolean): CardTone {
  if (nodes.some((node) => node.kind === "ask-po")) return "ask";
  if (nodes.some((node) => node.state === "blocked")) return "blocked";
  if (nodes.some((node) => node.state === "waiting-po")) return "waiting";
  if (nodes.some((node) => node.kind === "architect" && node.state === "current"))
    return "architect";
  return reworkActive ? "rework" : "work";
}

type Arrow = readonly [Point, Point, Point];
const pointRight = (tipX: number, y: number): Arrow => [
  [tipX - 8, y - 4],
  [tipX, y],
  [tipX - 8, y + 4],
];
const pointLeft = (tipX: number, y: number): Arrow => [
  [tipX + 8, y - 4],
  [tipX, y],
  [tipX + 8, y + 4],
];
const pointUp = (x: number, tipY: number): Arrow => [
  [x - 4, tipY + 9],
  [x, tipY],
  [x + 4, tipY + 9],
];

/** `templateId` names the workflow template in the corner; null when the template is unavailable. */
export function layoutWorkflowDiagram(
  diagram: WorkflowDiagram,
  templateId: string | null,
): DiagramLayout {
  const main = diagram.nodes.filter((node) => node.kind === "step" || node.kind === "gate");
  if (main.length === 0) return EMPTY;
  const extras = diagram.nodes.filter(
    (node) => node.kind === "architect" || node.kind === "ask-po",
  );
  const widthOf = (node: DiagramNode) => (node.kind === "step" ? STEP_W : GATE);
  const rowWidth = main.reduce((sum, node) => sum + widthOf(node), 0) + GAP * (main.length - 1);
  let width = Math.max(MIN_WIDTH, rowWidth + 2 * MARGIN);
  const currentId = currentNodeId(diagram.nodes);

  const nodes: LayoutNode[] = [];
  let cursor = Math.round((width - rowWidth) / 2);
  for (const node of main) {
    const w = widthOf(node);
    const cx = cursor + w / 2;
    const symbol = SYMBOLS[node.state];
    const common = {
      id: node.id,
      kind: node.kind,
      state: node.state,
      cls: node.state === "todo" ? "pending" : node.state,
      symbol,
      current: node.id === currentId,
    };
    if (node.kind === "step") {
      const text = `${symbol} ${shorten(STEP_NAMES[node.id] ?? capitalised(node.id), 7)}`;
      nodes.push({
        ...common,
        shape: { kind: "rect", x: cursor, y: ROW - STEP_H / 2, w, h: STEP_H },
        text: label(text, cx, ROW + 1, fitted(text, 8, 72), "middle", 24),
      });
    } else {
      const caption = gateCaption(node.id);
      nodes.push({
        ...common,
        shape: { kind: "diamond", x: cursor, y: ROW - GATE_H / 2, w, h: GATE_H },
        text: label(symbol, cx, ROW + 1, 10, "middle", 22),
        caption: label(caption, cx, 79, fitted(caption, 7, 38), "middle", 20),
      });
    }
    cursor += w + GAP;
  }

  const connectors: LayoutConnector[] = [];
  nodes.forEach((node, index) => {
    const next = nodes[index + 1];
    if (next === undefined) return;
    connectors.push({
      kind: "forward",
      prior: false,
      points: [
        [node.shape.x + node.shape.w, ROW],
        [next.shape.x - 3, ROW],
      ],
      arrow: pointRight(next.shape.x, ROW),
    });
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const centre = (node: LayoutNode) => node.shape.x + node.shape.w / 2;
  const stepBottom = ROW + STEP_H / 2;
  const edge = diagram.reworkEdge;
  const source = edge === undefined ? undefined : byId.get(edge.from);
  const target = edge === undefined ? undefined : byId.get(edge.to);
  const plates: LayoutPlate[] = [];
  let reworkActive = false;
  let loop = false;
  if (edge !== undefined && source !== undefined && target !== undefined && source !== target) {
    loop = true;
    // A loop still runs while review stands failed or held, or the rework target is being worked.
    reworkActive =
      ["failed", "waiting-po", "blocked"].includes(source.state) ||
      ["current", "blocked", "waiting-po", "failed"].includes(target.state);
    const distance = Math.abs(centre(source) - centre(target));
    // the wider "prior" plate only when it fits between the two verticals
    const prior = !reworkActive && distance >= 104 + 2 * 7 + 8 + 2 * 4;
    const plateW = prior ? 104 : 58;
    const text = `↶ ${String(edge.failures)}${prior ? " · prior" : ""}`;
    const mid = Math.round((centre(source) + centre(target)) / 2);
    const dir = centre(target) < centre(source) ? -1 : 1;
    const gap = plateW / 2 + 7; // the track stops 7 units outside either plate edge
    const dashed = !reworkActive;
    connectors.push(
      {
        kind: "return",
        prior: dashed,
        points: [
          [centre(source), stepBottom],
          [centre(source), TRACK_Y],
          [mid - dir * gap, TRACK_Y],
        ],
      },
      {
        kind: "return",
        prior: dashed,
        points: [
          [mid + dir * gap, TRACK_Y],
          [centre(target), TRACK_Y],
          [centre(target), stepBottom + 4],
        ],
        arrow: pointUp(centre(target), stepBottom + 1),
      },
    );
    plates.push({
      box: { x: mid - plateW / 2, y: 91, w: plateW, h: 26 },
      label: label(text, mid, TRACK_Y, prior ? 92 : 46, "middle", 24),
    });
  }

  // Escalation: a lower branch off the reviewer step to Architect and, when needed, Ask PO.
  const architect = extras.find((node) => node.kind === "architect");
  const ask = extras.find((node) => node.kind === "ask-po");
  const lastStep = [...nodes].reverse().find((node) => node.kind === "step");
  const branchFrom = loop && source !== undefined ? source : lastStep;
  const escalation = extras.length > 0 && branchFrom !== undefined;
  const extraNodes: LayoutNode[] = [];
  if (escalation) {
    const branchX = centre(branchFrom) + 30;
    const rightmost = Math.max(
      ...nodes.map((node) =>
        Math.max(
          node.shape.x + node.shape.w,
          node.caption?.box.x === undefined ? 0 : node.caption.box.x + node.caption.box.w,
        ),
      ),
    );
    const rowLeft = MARGIN;
    const rowWidthNeeded = (architect === undefined ? 0 : 130 + 62) + (ask === undefined ? 0 : 108);
    const lead = Math.max(centre(branchFrom) - 29, rowLeft + rowWidthNeeded);
    const channel = Math.max(rightmost + 15, lead + 140, branchX + 15);
    width = Math.max(width, channel + 15);
    const branchPoint = (right: number): Point[] => [
      [branchX, stepBottom],
      [branchX, BRANCH_Y],
      [channel, BRANCH_Y],
      [channel, ESCALATION_Y],
      [right + 3, ESCALATION_Y],
    ];
    const placed = (node: DiagramNode, w: number, right: number, kind: "escalation" | "ask") => {
      const textLength = node.kind === "architect" ? 104 : 88;
      const text = node.kind === "architect" ? "! Architect" : "? Ask PO";
      extraNodes.push({
        id: node.id,
        kind: node.kind,
        state: node.state,
        cls: kind,
        symbol: node.kind === "architect" ? "!" : "?",
        shape: { kind: "rect", x: right - w, y: ESCALATION_Y - 15, w, h: 30 },
        text: label(text, right - w / 2, ESCALATION_Y + 1, textLength, "middle", 24),
        current: node.id === currentId,
      });
    };
    let first = lead;
    if (architect !== undefined) {
      placed(architect, 130, lead, "escalation");
      first = lead - 130;
    } else if (ask !== undefined) placed(ask, 108, lead, "ask");
    connectors.push({
      kind: "branch",
      prior: false,
      points: branchPoint(lead),
      arrow: pointLeft(lead + 1, ESCALATION_Y),
    });
    if (architect !== undefined && ask !== undefined) {
      const askRight = first - 62;
      placed(ask, 108, askRight, "ask");
      connectors.push({
        kind: "ask",
        prior: false,
        points: [
          [first, ESCALATION_Y],
          [askRight + 3, ESCALATION_Y],
        ],
        arrow: pointLeft(askRight + 1, ESCALATION_Y),
      });
    }
  }

  const height = escalation ? 170 : loop ? 124 : 94;
  const all = [...nodes, ...extraNodes];
  const parts = [
    `${templateId ?? "workflow"}: ${nodes.map((node) => `${node.id} ${STATE_WORDS[node.state]}`).join("; ")}`,
  ];
  if (loop && edge !== undefined)
    parts.push(
      `rework ${edge.from} returns to ${edge.to}, count ${String(edge.failures)}${reworkActive ? "" : ", historical"}`,
    );
  if (escalation) {
    const named = [architect, ask].flatMap((node) =>
      node === undefined
        ? []
        : [`${node.kind === "architect" ? "Architect" : "Ask PO"} (${node.sub})`],
    );
    parts.push(`branch ${branchFrom.id} to ${named.join(", then ")}`);
  }
  const name = templateId ?? "";
  return {
    width,
    height,
    tone: toneOf(diagram.nodes, reworkActive),
    template: label(
      name,
      8,
      12,
      Math.min(68, Math.round(8.5 * Array.from(name).length)),
      "start",
      20,
    ),
    nodes: all,
    connectors,
    plates,
    description: parts.join("; "),
  };
}
