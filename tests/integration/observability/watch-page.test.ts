import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type {
  QuotaPanel,
  TaskCard,
  WatchSnapshot,
} from "../../../src/application/contracts/watch-snapshot.ts";
import type { StepStatus } from "../../../src/domain/runs/step-run.ts";
import {
  buildWorkflowDiagram,
  type DiagramWorkflow,
  type Hold,
} from "../../../src/domain/workflows/workflow-diagram.ts";
import { layoutWorkflowDiagram } from "../../../src/domain/workflows/workflow-diagram-layout.ts";
import { PAGE_CSP, PAGE_HTML } from "../../../src/infrastructure/observability/watch-page.ts";

class Element {
  textContent = "";
  scrollWidth = 0;
  clientWidth = 0;
  scrollLeft = 0;
  open = false;
  readonly children: Element[] = [];
  readonly attributes: Record<string, string> = {};
  readonly listeners: Record<string, (() => void)[]> = {};
  readonly tag: string;
  private readonly owner: Document | undefined;
  constructor(tag: string, owner?: Document) {
    this.tag = tag;
    this.owner = owner;
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
    if (name === "open") this.open = true;
    this.attributes[name] = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  addEventListener(name: string, listener: () => void) {
    (this.listeners[name] ??= []).push(listener);
  }
  focus() {
    if (this.owner !== undefined) this.owner.activeElement = this;
  }
}
interface Document {
  activeElement: Element | null;
}

function browser(metrics = { scrollWidth: 600, clientWidth: 600 }) {
  const ids = new Map<string, Element>();
  const doc: Document & {
    getElementById: (id: string) => Element;
    createElement: (tag: string) => Element;
    createElementNS: (namespace: string, tag: string) => Element;
  } = {
    activeElement: null,
    getElementById: (id) => {
      let found = ids.get(id);
      if (found === undefined) {
        found = new Element("div");
        ids.set(id, found);
      }
      return found;
    },
    createElement: (tag) => {
      const element = new Element(tag, doc);
      element.scrollWidth = metrics.scrollWidth;
      element.clientWidth = metrics.clientWidth;
      return element;
    },
    createElementNS: (_namespace, tag) => new Element(tag, doc),
  };
  const streams: {
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    onopen?: () => void;
  }[] = [];
  class EventSource {
    constructor(url: string) {
      expect(url).toBe("/events");
      streams.push(this);
    }
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    onopen?: () => void;
  }
  const source = /<script>([\s\S]*?)<\/script>/.exec(PAGE_HTML)?.[1];
  if (source === undefined) throw new Error("missing script");
  runInNewContext(source, { EventSource, document: doc });
  const stream = () => {
    const first = streams[0];
    if (first === undefined) throw new Error("no stream");
    return first;
  };
  return {
    doc,
    tasks: doc.getElementById("tasks"),
    quota: doc.getElementById("quota"),
    quotaMeta: doc.getElementById("quota-meta"),
    connection: doc.getElementById("connection"),
    notice: doc.getElementById("notice"),
    totals: doc.getElementById("totals"),
    send: (data: unknown) => stream().onmessage?.({ data: JSON.stringify(data) }),
    raw: (data: string) => stream().onmessage?.({ data }),
    fail: () => stream().onerror?.(),
  };
}

const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const texts = (node: Element) =>
  all(node)
    .map((element) => element.textContent)
    .filter((value) => value !== "");
const byClass = (node: Element, cls: string) =>
  all(node).filter((element) => (element.attributes["class"] ?? "").split(" ").includes(cls));

const hostile = '<img src=x onerror="globalThis.pwned=true">';
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
const NO_REWORK = { phase: "before-architect", rework: 0, of: 2, architect: "none" } as const;

function card(
  statuses: Record<string, StepStatus>,
  overrides: Partial<TaskCard> = {},
  options: { hold?: Hold; failures?: number } = {},
): TaskCard {
  const diagram = buildWorkflowDiagram({
    workflow: FEATURE,
    steps: new Map(Object.entries(statuses)),
    cycle: NO_REWORK,
    failures: options.failures ?? 0,
    ...(options.hold === undefined ? {} : { hold: options.hold }),
  });
  return {
    runId: "run-1",
    issueNumber: 164,
    planKey: "OMI-081",
    title: "Show worker progress by workflow step",
    workflow: "feature",
    runStatus: "running",
    step: "implement",
    role: "developer",
    who: {
      executor: "codex",
      profileId: "profile-a",
      model: "gpt-6.1-sol",
      effort: "medium",
      startedAt: "2026-11-12T09:48:00.000Z",
      step: "implement",
      role: "developer",
      elapsedSeconds: 738,
    },
    loaded: {
      skills: ["minimal-change", "test-driven-development"],
      rules: ["project-baseline", "evidence-and-tests"],
      mandatoryRules: ["project-baseline"],
    },
    skillCheck: { expected: ["minimal-change"], missing: [], extra: [] },
    cycle: { ...NO_REWORK, failures: options.failures ?? 0 },
    hold: options.hold ?? null,
    diagram,
    layout: layoutWorkflowDiagram(diagram, "feature"),
    notes: [],
    ...overrides,
  };
}
const QUOTA: QuotaPanel = {
  state: "ok",
  reason: null,
  rows: [
    {
      tool: "claude",
      profile: "profile-a",
      fiveHourLeft: 16,
      sevenDayLeft: 62,
      resetText: "16:30",
      severity: "low",
      freshness: "fresh",
      note: null,
    },
    {
      tool: "codex",
      profile: "profile-a",
      fiveHourLeft: null,
      sevenDayLeft: null,
      resetText: null,
      severity: "unknown",
      freshness: "unknown",
      note: null,
    },
  ],
};
const snapshot = (tasks: TaskCard[], overrides: Partial<WatchSnapshot> = {}): WatchSnapshot => ({
  schemaVersion: 1,
  generatedAt: "2026-11-12T10:00:00.000Z",
  board: "ok",
  tasks,
  quota: QUOTA,
  ...overrides,
});
const frame = (value: WatchSnapshot) => ({ state: "ok", snapshot: value });

describe("watch page: card anatomy (approved design)", () => {
  it("draws a card as header, workflow diagram, one-line footer and a closed skills & rules toggle", () => {
    const page = browser();
    page.send(frame(snapshot([card({ analyze: "succeeded", implement: "running" })])));
    const article = page.tasks.children[0];
    if (article === undefined) throw new Error("no card");
    expect(article.tag).toBe("article");
    expect(article.children.map((child) => child.tag)).toEqual([
      "header",
      "div",
      "footer",
      "details",
    ]);
    const header = article.children[0];
    expect(header?.children.map((child) => child.textContent)).toEqual([
      "OMI-081",
      "Show worker progress by workflow step",
    ]);
    expect(article.children[2]?.textContent).toBe(
      "developer · implement · codex/profile-a · gpt-6.1-sol/medium · 12m 18s",
    );
    const details = article.children[3];
    expect(details?.open).toBe(false);
    expect(details?.children[0]?.textContent).toBe("Skills & rules");
    expect(article.attributes["class"]).toBe("card work");
  });

  it("draws each template node, the arrows between them and exactly one current node", () => {
    const page = browser();
    page.send(frame(snapshot([card({ analyze: "succeeded", implement: "running" })])));
    const svg = all(page.tasks).find((element) => element.tag === "svg");
    expect(svg?.attributes["viewBox"]).toBe("0 0 600 94");
    expect(svg?.attributes["role"]).toBe("img");
    expect(svg?.attributes["aria-label"]).toContain("implement current");
    const nodes = byClass(page.tasks, "node");
    expect(nodes).toHaveLength(6);
    expect(nodes.filter((node) => node.attributes["aria-current"] === "step")).toHaveLength(1);
    expect(byClass(page.tasks, "forward")).toHaveLength(5);
    expect(all(page.tasks).filter((element) => element.tag === "polygon")).not.toHaveLength(0);
    expect(texts(page.tasks)).toContain("▶ Build");
    expect(texts(page.tasks)).toContain("Scope");
  });

  it("draws every connector from the layout with orthogonal path commands only", () => {
    const page = browser();
    page.send(
      frame(
        snapshot([
          card(
            { analyze: "succeeded", implement: "running", verify: "succeeded", review: "failed" },
            {},
            { failures: 2 },
          ),
        ]),
      ),
    );
    const paths = all(page.tasks).filter((element) => element.tag === "path");
    expect(byClass(page.tasks, "return")).toHaveLength(2);
    for (const path of paths) expect(path.attributes["d"]).toMatch(/^M [\d. ]+( L [\d. ]+)+$/);
    expect(texts(page.tasks)).toContain("↶ 2");
    expect(page.tasks.children[0]?.attributes["class"]).toBe("card rework");
  });

  it("shows no worker plus the hold in the footer, and marks the held gate", () => {
    const page = browser();
    page.send(
      frame(
        snapshot([
          card(
            { analyze: "succeeded" },
            { who: null, loaded: null, skillCheck: null },
            { hold: { kind: "waiting-po" } },
          ),
        ]),
      ),
    );
    const article = page.tasks.children[0];
    expect(article?.children[2]?.textContent).toBe("no worker · Waiting PO");
    expect(article?.attributes["class"]).toBe("card waiting");
    const summary = article?.children[3]?.children[0];
    expect(summary?.textContent).toBe("Skills & rules");
    expect(texts(article ?? page.tasks)).toContain("No running worker · loaded set unavailable");
  });

  it("names the blocking issues in the footer of a blocked card", () => {
    const page = browser();
    page.send(
      frame(
        snapshot([
          card(
            { analyze: "succeeded" },
            { who: null, loaded: null, skillCheck: null },
            { hold: { kind: "blocked", by: [12, 15] } },
          ),
        ]),
      ),
    );
    expect(page.tasks.children[0]?.children[2]?.textContent).toBe("no worker · Blocked by #12 +1");
  });

  it("writes unknown, never a made-up value, for what the source could not say", () => {
    const page = browser();
    const base = card({ analyze: "succeeded", implement: "running" });
    page.send(
      frame(
        snapshot([
          {
            ...base,
            planKey: null,
            title: null,
            who: {
              executor: "codex",
              profileId: "profile-a",
              model: "gpt-6.1-sol",
              effort: null,
              startedAt: null,
              step: null,
              role: null,
              elapsedSeconds: null,
            },
          },
        ]),
      ),
    );
    const article = page.tasks.children[0];
    expect(article?.children[0]?.children.map((child) => child.textContent)).toEqual([
      "#164",
      "Untitled task",
    ]);
    expect(article?.children[2]?.textContent).toBe(
      "unknown · unknown · codex/profile-a · gpt-6.1-sol/unknown · unknown",
    );
  });

  it("lists the running worker's skills and rules, marking mandatory rules, extra skills and missing ones", () => {
    const page = browser();
    page.send(
      frame(
        snapshot([
          card(
            { analyze: "succeeded", implement: "running" },
            {
              skillCheck: {
                expected: ["verification-before-completion"],
                missing: ["verification-before-completion"],
                extra: [{ name: "minimal-change", template: null }],
              },
            },
          ),
        ]),
      ),
    );
    const chips = byClass(page.tasks, "chip").map((chip) => chip.textContent);
    expect(chips).toEqual([
      "! Extra · minimal-change",
      "test-driven-development",
      "◆ project-baseline",
      "○ evidence-and-tests",
    ]);
    expect(texts(page.tasks)).toContain("× Expected skill missing: verification-before-completion");
  });

  it("does not mark rules as mandatory when the source cannot tell", () => {
    const page = browser();
    const base = card({ analyze: "succeeded", implement: "running" });
    page.send(
      frame(
        snapshot([
          {
            ...base,
            loaded: { skills: [], rules: ["project-baseline"], mandatoryRules: null },
          },
        ]),
      ),
    );
    expect(byClass(page.tasks, "chip").map((chip) => chip.textContent)).toContain(
      "project-baseline",
    );
  });

  it("says Template unavailable instead of drawing an invented diagram", () => {
    const page = browser();
    const base = card({});
    page.send(
      frame(
        snapshot([
          {
            ...base,
            workflow: null,
            diagram: { nodes: [] },
            layout: layoutWorkflowDiagram({ nodes: [] }, null),
          },
        ]),
      ),
    );
    expect(texts(page.tasks)).toContain("Template unavailable");
    expect(all(page.tasks).some((element) => element.tag === "svg")).toBe(false);
  });
});

describe("watch page: quota panel", () => {
  it("shows one row per profile with a colour-only bar and 5h, 7d and reset on the same line", () => {
    const page = browser();
    page.send(frame(snapshot([])));
    const rows = byClass(page.quota, "quota-row");
    expect(rows.map((row) => row.children.map((child) => child.textContent))).toEqual([
      ["Claude", "profile-a", "", "5h 16%", "7d 62%", "reset 16:30"],
      ["Codex", "profile-a", "", "5h —", "7d —", "reset —"],
    ]);
    const [low, unknown] = rows.map((row) => row.children[2]);
    expect(low?.attributes["class"]).toBe("quota-bar low");
    expect(low?.attributes["aria-label"]).toBe("low quota, 16 percent remaining");
    expect(unknown?.attributes["class"]).toBe("quota-bar unknown");
    expect(unknown?.attributes["aria-label"]).toBe("quota unknown");
    expect(page.quotaMeta.textContent).toBe("2 profiles");
  });

  it("shows why a row's numbers are old instead of hiding the note", () => {
    const page = browser();
    const [first, second] = QUOTA.rows;
    if (first === undefined || second === undefined) throw new Error("no rows");
    const note = "token expired, data 9h old";
    page.send(frame(snapshot([], { quota: { ...QUOTA, rows: [{ ...first, note }, second] } })));
    const [withNote, without] = byClass(page.quota, "quota-row");
    expect(texts(withNote ?? page.quota)).toContain(note);
    expect(texts(without ?? page.quota)).not.toContain(note);
  });

  it("never turns an unknown reading into 0 or into a filled bar", () => {
    const page = browser();
    page.send(frame(snapshot([])));
    const unknownRow = byClass(page.quota, "quota-row")[1];
    if (unknownRow === undefined) throw new Error("no row");
    expect(texts(unknownRow).join(" ")).not.toContain("0%");
    expect(all(unknownRow).some((element) => element.tag === "rect")).toBe(false);
  });

  it("labels the panel instead of showing numbers when quota is unavailable or not configured", () => {
    const page = browser();
    page.send(
      frame(
        snapshot([], { quota: { state: "unavailable", reason: "QUOTA_READ_FAILED", rows: [] } }),
      ),
    );
    expect(page.quotaMeta.textContent).toBe("Quota unavailable: QUOTA_READ_FAILED");
    expect(texts(page.quota)).toContain("Quota unknown");
    page.send(frame(snapshot([], { quota: { state: "not-configured", reason: null, rows: [] } })));
    expect(page.quotaMeta.textContent).toBe("Quota not configured");
  });

  it("marks a stale reading and clamps a bar value outside 0..100", () => {
    const page = browser();
    const row = QUOTA.rows[0];
    if (row === undefined) throw new Error("no row");
    page.send(
      frame(
        snapshot([], {
          quota: {
            state: "ok",
            reason: null,
            rows: [{ ...row, freshness: "stale", fiveHourLeft: 140 }],
          },
        }),
      ),
    );
    const line = byClass(page.quota, "quota-row")[0];
    expect(line?.children[5]?.textContent).toBe("reset 16:30 · stale");
    const rect = all(line ?? page.quota).find((element) => element.tag === "rect");
    expect(rect?.attributes["width"]).toBe("100");
  });
});

describe("watch page: totals, states and updates", () => {
  it("counts tasks, workers, PO decisions and blocked tasks", () => {
    const page = browser();
    page.send(
      frame(
        snapshot([
          card({ analyze: "succeeded", implement: "running" }),
          card(
            { analyze: "succeeded" },
            { runId: "run-2", who: null, loaded: null, skillCheck: null },
            { hold: { kind: "waiting-po" } },
          ),
          card(
            { analyze: "succeeded" },
            { runId: "run-3", who: null, loaded: null, skillCheck: null },
            { hold: { kind: "blocked", by: [4] } },
          ),
        ]),
      ),
    );
    expect(texts(page.totals)).toEqual([
      "3",
      " tasks",
      "1",
      " workers",
      "1",
      " PO decisions",
      "1",
      " blocked",
    ]);
  });

  it("says there are no active tasks only after a successful empty response", () => {
    expect(PAGE_HTML).toContain("Loading tasks / quota");
    const page = browser();
    page.send(frame(snapshot([])));
    expect(texts(page.tasks)).toEqual(["No active tasks"]);
  });

  it("keeps saying loading while the board's first read runs, not no active tasks", () => {
    const page = browser();
    page.send(frame(snapshot([], { board: "loading" })));
    expect(texts(page.tasks)).toEqual(["Loading tasks / quota"]);
  });

  it("keeps the last good cards and says so when a snapshot is unavailable or the stream drops", () => {
    const page = browser();
    page.send(frame(snapshot([card({ analyze: "succeeded", implement: "running" })])));
    page.send({ state: "unavailable", reason: "SNAPSHOT_FAILED" });
    expect(page.tasks.children).toHaveLength(1);
    expect(page.connection.textContent).toContain("read-only");
    expect(page.connection.textContent).toContain("2026-11-12T10:00:00.000Z");
    expect(page.connection.attributes["class"]).toBe("live stale");
    page.fail();
    expect(page.connection.textContent).toContain("reconnecting");
    expect(page.tasks.children).toHaveLength(1);
    page.send(frame(snapshot([card({ analyze: "succeeded", implement: "running" })])));
    expect(page.connection.attributes["class"]).toBe("live");
  });

  it("flags GitHub trouble without erasing runtime cards", () => {
    const page = browser();
    page.send(
      frame(
        snapshot([card({ analyze: "succeeded", implement: "running" })], { board: "unavailable" }),
      ),
    );
    expect(page.notice.textContent).toContain("GitHub board unavailable");
    expect(page.notice.attributes["class"]).toBe("notice warn");
    expect(page.tasks.children).toHaveLength(1);
  });

  it("survives a malformed frame without throwing or clearing the page", () => {
    const page = browser();
    page.send(frame(snapshot([card({ analyze: "succeeded", implement: "running" })])));
    expect(() => page.raw("{not json")).not.toThrow();
    expect(page.tasks.children).toHaveLength(1);
    expect(page.connection.attributes["class"]).toBe("live stale");
  });

  it("keeps a panel open and its focus across an update", () => {
    const page = browser();
    const view = snapshot([card({ analyze: "succeeded", implement: "running" })]);
    page.send(frame(view));
    const details = page.tasks.children[0]?.children[3];
    const summary = details?.children[0];
    if (details === undefined || summary === undefined) throw new Error("no panel");
    details.open = true;
    for (const listener of details.listeners["toggle"] ?? []) listener();
    summary.focus();
    page.send(frame({ ...view, generatedAt: "2026-11-12T10:00:05.000Z" }));
    const next = page.tasks.children[0]?.children[3];
    expect(next).not.toBe(details);
    expect(next?.open).toBe(true);
    expect(page.doc.activeElement).toBe(next?.children[0]);
    // closing it sticks too
    if (next === undefined) throw new Error("no panel");
    next.open = false;
    delete next.attributes["open"];
    for (const listener of next.listeners["toggle"] ?? []) listener();
    page.send(frame(view));
    expect(page.tasks.children[0]?.children[3]?.open).toBe(false);
  });
});

describe("watch page: security (OMI-067)", () => {
  const evil = (): WatchSnapshot => {
    const base = card({ analyze: "succeeded", implement: "running" }, {}, { failures: 1 });
    return snapshot(
      [
        {
          ...base,
          planKey: hostile,
          title: hostile,
          notes: [hostile],
          loaded: { skills: [hostile], rules: [hostile], mandatoryRules: [hostile] },
          skillCheck: {
            expected: [],
            missing: [hostile],
            extra: [{ name: hostile, template: null }],
          },
          who: {
            executor: hostile,
            profileId: hostile,
            model: hostile,
            effort: hostile,
            startedAt: null,
            step: hostile,
            role: hostile,
            elapsedSeconds: 1,
          },
          layout: {
            ...base.layout,
            tone: hostile as never,
            description: hostile,
            nodes: base.layout.nodes.map((node) => ({
              ...node,
              cls: hostile,
              text: { ...node.text, text: hostile },
            })),
          },
        },
      ],
      {
        quota: {
          state: "ok",
          reason: null,
          rows: [
            {
              tool: "claude",
              profile: hostile,
              fiveHourLeft: 50,
              sevenDayLeft: 50,
              resetText: hostile,
              severity: hostile as never,
              freshness: "fresh",
              note: hostile,
            },
          ],
        },
        generatedAt: hostile,
      },
    );
  };

  it("puts every external string into a text node", () => {
    const page = browser();
    page.send(frame(evil()));
    expect(texts(page.tasks).join("\n")).toContain(hostile);
    expect(texts(page.quota).join("\n")).toContain(hostile);
    expect(all(page.tasks).some((element) => element.tag === "img")).toBe(false);
    expect(all(page.quota).some((element) => element.tag === "img")).toBe(false);
  });

  it("never uses an external string as a class, id or style value", () => {
    const page = browser();
    page.send(frame(evil()));
    const attributes = [...all(page.tasks), ...all(page.quota)].flatMap((element) =>
      Object.entries(element.attributes).filter(([name]) => name !== "aria-label"),
    );
    expect(attributes.map(([, value]) => value)).not.toContain(hostile);
    expect(attributes.some(([name]) => name === "style")).toBe(false);
    expect(page.tasks.children[0]?.attributes["class"]).toBe("card work");
    expect(byClass(page.quota, "quota-bar")[0]?.attributes["class"]).toBe("quota-bar unknown");
  });

  it("offers no control: no form, button, link out, probe or POST", () => {
    expect(PAGE_HTML).not.toMatch(
      /<form|<button|<input|<iframe|<object|<embed|<a [^>]*href="http/i,
    );
    expect(PAGE_HTML).not.toMatch(
      /probe|method:|fetch\(|XMLHttpRequest|innerHTML|insertAdjacent|eval\(/i,
    );
    expect(PAGE_HTML).not.toMatch(/<img|<link|src=/i);
    expect(PAGE_HTML).not.toMatch(/style="/);
  });

  it("pins the exact script and style by hash and allows nothing else", async () => {
    const { createHash } = await import("node:crypto");
    const hashOf = (value: string) =>
      `'sha256-${createHash("sha256").update(value).digest("base64")}'`;
    const script = /<script>([\s\S]*?)<\/script>/.exec(PAGE_HTML)?.[1] ?? "";
    const style = /<style>([\s\S]*?)<\/style>/.exec(PAGE_HTML)?.[1] ?? "";
    expect(PAGE_CSP).toContain(`script-src ${hashOf(script)};`);
    expect(PAGE_CSP).toContain(`style-src ${hashOf(style)};`);
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).toContain("connect-src 'self'");
    expect(PAGE_CSP).not.toContain("unsafe");
  });
});

describe("watch page: small windows (verify round 1)", () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(PAGE_HTML)?.[1] ?? "";
  const narrow = (query: string) => {
    const start = css.indexOf(`@media(max-width:${query}){`);
    if (start < 0) throw new Error(`no ${query} rule`);
    return css.slice(start, css.indexOf("}}", start) + 2);
  };

  it("gives the diagram its natural size, in a focusable scroll region, instead of shrinking it", () => {
    const page = browser({ scrollWidth: 600, clientWidth: 330 });
    page.send(frame(snapshot([card({ analyze: "succeeded", implement: "running" })])));
    const body = page.tasks.children[0]?.children[1];
    expect(body?.attributes["tabindex"]).toBe("0");
    expect(body?.attributes["role"]).toBe("region");
    expect(body?.attributes["aria-label"]).toContain("scroll");
    const svg = body?.children[0];
    expect(svg?.attributes["width"]).toBe("600");
    expect(svg?.attributes["height"]).toBe("94");
    const small = narrow("699px");
    expect(small).toContain(".card-body{overflow-x:auto}");
    expect(small).toContain(".flow{width:auto;max-width:none}");
  });

  it("adds no tab stop to a diagram that fits", () => {
    const page = browser({ scrollWidth: 600, clientWidth: 600 });
    page.send(frame(snapshot([card({ analyze: "succeeded", implement: "running" })])));
    const body = page.tasks.children[0]?.children[1];
    expect(body?.attributes["tabindex"]).toBeUndefined();
    expect(body?.attributes["role"]).toBeUndefined();
    expect(body?.scrollLeft).toBe(0);
  });

  it("scrolls the current node into view on first render", () => {
    const page = browser({ scrollWidth: 600, clientWidth: 330 });
    page.send(frame(snapshot([card({ analyze: "succeeded", implement: "running" })])));
    const view = snapshot([card({ analyze: "succeeded", implement: "running" })]);
    const current = view.tasks[0]?.layout.nodes.find((node) => node.current);
    if (current === undefined) throw new Error("no current node");
    const centre = current.shape.x + current.shape.w / 2;
    expect(page.tasks.children[0]?.children[1]?.scrollLeft).toBe(centre - 330 / 2);
  });

  it("does not scroll when the current node is already near the left edge", () => {
    const page = browser({ scrollWidth: 600, clientWidth: 330 });
    page.send(frame(snapshot([card({})])));
    expect(page.tasks.children[0]?.children[1]?.scrollLeft).toBe(0);
  });

  it("keeps the reader's scroll position across later updates", () => {
    const page = browser({ scrollWidth: 600, clientWidth: 330 });
    const view = snapshot([card({ analyze: "succeeded", implement: "running" })]);
    page.send(frame(view));
    const body = page.tasks.children[0]?.children[1];
    if (body === undefined) throw new Error("no body");
    body.scrollLeft = 42;
    page.send(frame({ ...view, generatedAt: "2026-11-12T10:00:05.000Z" }));
    const next = page.tasks.children[0]?.children[1];
    expect(next).not.toBe(body);
    expect(next?.scrollLeft).toBe(42);
  });

  it("lets the card footer wrap instead of scrolling or clipping worker facts", () => {
    const footer = /\.card-footer\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(footer).toContain("overflow-wrap:anywhere");
    expect(footer).not.toContain("nowrap");
    expect(footer).not.toContain("overflow-x");
  });

  it("stacks the quota bar and values under the name so 5h and 7d show at 320px", () => {
    expect(/\.quota-row\{[^}]*\}/.exec(css)?.[0]).toContain("min-width:710px");
    const small = narrow("760px");
    expect(small).toContain(".quota-row{min-width:0;grid-template-columns:70px 1fr 1fr");
    expect(small).toContain("grid-column:1/-1");
  });

  it("allows two title lines, keeps each total whole and trims the toggle on phones", () => {
    const phone = narrow("899px");
    expect(phone).toContain("h3{white-space:normal");
    expect(phone).toContain("-webkit-line-clamp:2");
    expect(css).toContain(".totals span{white-space:nowrap}");
    expect(phone).toContain(".context-toggle summary{display:flex;align-items:center");
  });
});

describe("watch page: accessibility and theme", () => {
  it("has a skip link, landmarks, a labelled focusable quota region and both colour schemes", () => {
    expect(PAGE_HTML).toContain('<a class="skip" href="#tasks">');
    expect(PAGE_HTML).toContain("<main>");
    expect(PAGE_HTML).toContain('role="status"');
    expect(PAGE_HTML).toContain('id="quota" tabindex="0" role="region"');
    expect(PAGE_HTML).toContain("prefers-color-scheme:dark");
    expect(PAGE_HTML).toContain("prefers-reduced-motion:reduce");
    expect(PAGE_HTML).toContain("repeat(3,minmax(0,1fr))");
    expect(PAGE_HTML).toContain("@media(max-width:1359px)");
    expect(PAGE_HTML).toContain("@media(max-width:899px)");
    expect(PAGE_HTML).toContain(":focus-visible{outline:3px solid");
  });

  it("explains every state symbol in the legend", () => {
    for (const symbol of [
      "✓ Done",
      "▶ Current",
      "○ Pending",
      "× Failed",
      "Ⅱ Waiting PO",
      "⊘ Blocked",
      "– Skipped",
      "↶ Rework count",
      "! Architect",
      "? Ask PO",
    ])
      expect(PAGE_HTML).toContain(symbol);
  });
});
