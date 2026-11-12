import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { PAGE_HTML } from "../../../../tools/coordinator/watch-page.ts";
import { buildTasks, diagramNodes } from "../../../../tools/coordinator/watch-tasks.ts";
import { WINDOW_SIZE } from "../../../../tools/coordinator/watch-web.ts";

const block = (tag: string) =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(PAGE_HTML)?.[1] ?? "";

describe("watch page (Tasks and lifecycle diagram)", () => {
  it("ships a script that parses", () => {
    expect(() => new Script(block("script"))).not.toThrow();
  });

  it("replaces Workers by Tasks and draws the diagram as inline SVG, without innerHTML", () => {
    const js = block("script");
    expect(js).toContain('heading("Tasks")');
    expect(js).not.toContain('heading("Workers")');
    expect(js).toContain("createElementNS");
    expect(js).toContain("aria-label");
    expect(PAGE_HTML).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(PAGE_HTML).not.toMatch(/(?:src|href)=["']https?:/);
  });

  it("knows every node id of the diagram so each one gets a visible text label", () => {
    const js = block("script");
    for (const n of diagramNodes("Start", 0, false)) expect(js).toContain(`"${n.id}"`);
    // every node state has a style in both themes (colours come from the shared tokens)
    for (const state of ["done", "cur", "todo", "lit", "warn", "idle"])
      expect(block("style")).toContain(`.n.${state}`);
    expect(block("style")).toContain("prefers-color-scheme: dark");
  });

  it("fits the window without horizontal scroll", () => {
    const css = block("style");
    expect(css).toContain("overflow-x: hidden");
    expect(css).toMatch(/svg\.flow\s*\{[^}]*width:\s*100%/);
    const [w, h] = WINDOW_SIZE.split(",").map(Number);
    expect(w).toBeGreaterThanOrEqual(520);
    expect(h).toBeGreaterThanOrEqual(600);
  });
});

// A just-enough DOM: enough to run the page script on a real snapshot and read the tree back.
class FakeNode {
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  className = "";
  textContent = "";
  title = "";
  style: Record<string, string> = {};
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  appendChild(c: FakeNode) {
    this.children.push(c);
    return c;
  }
  replaceChildren(...c: FakeNode[]) {
    this.children = c;
  }
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

function renderInDom(tasks: unknown) {
  const app = new FakeNode("main");
  const conn = new FakeNode("span");
  const document = {
    getElementById: (id: string) => (id === "app" ? app : conn),
    createElement: (t: string) => new FakeNode(t),
    createElementNS: (_ns: string, t: string) => new FakeNode(t),
  };
  let onmessage: ((ev: { data: string }) => void) | undefined;
  const context = createContext({
    document,
    EventSource: class {
      set onmessage(fn: (ev: { data: string }) => void) {
        onmessage = fn;
      }
    },
    setInterval: () => 0,
    fetch: () => Promise.resolve({ ok: true }),
    Date,
    Math,
    JSON,
    Object,
    String,
  });
  new Script(block("script")).runInContext(context);
  onmessage?.({
    data: JSON.stringify({
      generatedAt: 1,
      staleAfterSeconds: 1800,
      probing: false,
      tasks,
      quota: { state: "ok", reason: null, profiles: [] },
    }),
  });
  return app;
}

describe("watch page rendering (fake DOM)", () => {
  const comment = (body: string) => ({ author: "minibox-claude-code", body });
  const head = "abc1234def5678abc1234def5678abc1234def56";
  const view = buildTasks({
    workers: { available: true, processes: [], latestLog: null },
    tasks: {
      available: true,
      items: [
        {
          kind: "Issue",
          number: 152,
          title: '<script>alert(1)</script> "quoted"',
          state: "OPEN",
          status: "In Review",
          priority: "P1",
          workType: "Task",
          planKey: "OMI-074",
          body: "",
          workflow: "Development",
          role: "Developer",
          area: null,
          milestone: null,
          blockers: [],
          blockersTruncated: false,
        },
      ],
      pulls: [
        {
          number: 160,
          title: "t",
          isDraft: false,
          headRefName: "task/omi-074-x",
          headRefOid: head,
          baseRefName: "develop",
          body: "Issue: #152",
          reviewDecision: null,
          mergeStateStatus: "CLEAN",
          comments: [
            comment("**VERDICT:** FAIL\n**REVIEWED_HEAD:** 1111111"),
            comment("**VERDICT:** FAIL\n**REVIEWED_HEAD:** 2222222"),
          ],
          checks: [],
        },
      ],
      prompts: { "OMI-074": { skills: ["minimal-change"], rules: ["AGENTS.md"] } },
    },
  });

  it("draws one labelled SVG per task with aria-label, rework badge and the Architect warning", () => {
    const app = renderInDom(view);
    const nodes = app.all();
    const svg = nodes.find((n) => n.tag === "svg");
    expect(svg?.attrs["aria-label"]).toBe("OMI-074: current step Review");
    expect(svg?.attrs.viewBox).toBe("0 0 540 124");
    const groups = nodes.filter((n) => n.tag === "g" && (n.attrs.class ?? "").startsWith("n "));
    expect(groups.map((g) => g.children[1]?.textContent)).toEqual([
      "Start",
      "Work",
      "Verify/PR",
      "Review",
      "Merge",
      "Done",
      "Rework",
      "Architect",
    ]);
    expect(groups.map((g) => g.attrs.class)).toEqual([
      "n done",
      "n done",
      "n done",
      "n cur",
      "n todo",
      "n todo",
      "n done",
      "n warn",
    ]);
    const badge = nodes.find((n) => n.attrs.class === "badge");
    expect(badge?.children[1]?.textContent).toBe("×2");
  });

  it("puts external strings in textContent or attributes, never as markup", () => {
    const text = renderInDom(view)
      .all()
      .map((n) => n.textContent)
      .join("\n");
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain("Skills: minimal-change");
    expect(text).toContain("Rules: AGENTS.md, no push, PR or merge, gh is read-only");
  });

  it("shows loading and unavailable states", () => {
    expect(
      renderInDom({ state: "loading" })
        .all()
        .some((n) => n.textContent === "Loading…"),
    ).toBe(true);
    expect(
      renderInDom({ state: "unavailable", reason: "gh failed" })
        .all()
        .some((n) => n.textContent === "GitHub unavailable: gh failed (retrying)"),
    ).toBe(true);
  });
});
