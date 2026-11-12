import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PAGE_HTML } from "../../../src/infrastructure/observability/watch-page.ts";

class Element {
  textContent = "";
  readonly children: Element[] = [];
  readonly attributes: Record<string, string> = {};
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  set innerHTML(_text: string) {
    throw new Error("HTML sink used");
  }
  appendChild(child: Element) {
    this.children.push(child);
  }
  replaceChildren() {
    this.children.splice(0);
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
}
function browser() {
  const root = new Element("main");
  const connection = new Element("p");
  const streams: { onmessage?: (event: { data: string }) => void }[] = [];
  class EventSource {
    constructor(url: string) {
      expect(url).toBe("/events");
      streams.push(this);
    }
    onmessage?: (event: { data: string }) => void;
  }
  const source = /<script>([\s\S]*?)<\/script>/.exec(PAGE_HTML)?.[1];
  if (source === undefined) throw new Error("missing script");
  runInNewContext(source, {
    EventSource,
    document: {
      getElementById: (id: string) => (id === "tasks" ? root : connection),
      createElement: (tag: string) => new Element(tag),
      createElementNS: (_namespace: string, tag: string) => new Element(tag),
    },
  });
  return {
    root,
    connection,
    send: (data: unknown) => streams[0]?.onmessage?.({ data: JSON.stringify(data) }),
  };
}
const hostile = '<img src=x onerror="globalThis.pwned=true">';
const task = (state = "blocked") => ({
  issueNumber: 164,
  planKey: "OMI-081",
  title: hostile,
  workflow: "custom",
  runStatus: "blocked",
  hold: { kind: "blocked" },
  who: null,
  loaded: { skills: [hostile], rules: [hostile] },
  skillCheck: null,
  cycle: { rework: 1, of: 2, phase: "before-architect" },
  notes: [hostile],
  diagram: {
    nodes: [
      {
        id: "build",
        label: hostile,
        kind: "step",
        state,
        sub: hostile,
        skills: [hostile],
        rules: [],
      },
    ],
    reworkEdge: { from: "audit", to: "build", failures: 1 },
  },
});
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
describe("watch page executing its actual browser script", () => {
  it("draws the runtime's rework connection through Architect and the Ask PO branch", () => {
    const page = browser();
    const card = task();
    card.diagram.nodes = [
      {
        label: "Build",
        kind: "step",
        state: "current",
        sub: "developer",
        skills: [],
        rules: [],
        id: "build",
      },
      {
        label: "Audit",
        kind: "step",
        state: "failed",
        sub: "reviewer",
        skills: [],
        rules: [],
        id: "audit",
      },
      {
        label: "Architect",
        kind: "architect",
        state: "done",
        sub: "called",
        skills: [],
        rules: [],
        id: "architect",
      },
      {
        label: "Ask PO",
        kind: "ask-po",
        state: "waiting-po",
        sub: "PO decides",
        skills: [],
        rules: [],
        id: "ask-po",
      },
    ];
    page.send({ state: "ok", snapshot: { generatedAt: "now", board: "ok", tasks: [card] } });
    const elements = all(page.root);
    expect(elements.filter((element) => element.tag === "svg")).toHaveLength(1);
    expect(
      elements.filter(
        (element) => element.tag === "path" && element.attributes["class"] === "rework",
      ),
    ).toHaveLength(2);
    expect(
      elements.some(
        (element) => element.tag === "path" && element.attributes["class"] === "ask-po",
      ),
    ).toBe(true);
  });
  it("puts external strings into text nodes, and displays the runtime rework edge", () => {
    const page = browser();
    page.send({ state: "ok", snapshot: { generatedAt: "now", board: "ok", tasks: [task()] } });
    const text = all(page.root)
      .map((element) => element.textContent)
      .join("\n");
    expect(text).toContain(hostile);
    expect(text).toContain("Blocked");
    expect(text).toContain("audit → build");
    expect(all(page.root).some((element) => element.tag === "img")).toBe(false);
  });
  it("never uses an external state string as an attribute value", () => {
    const page = browser();
    page.send({
      state: "ok",
      snapshot: { generatedAt: "now", board: "ok", tasks: [task(hostile)] },
    });
    expect(all(page.root).flatMap((element) => Object.values(element.attributes))).not.toContain(
      hostile,
    );
  });
});
