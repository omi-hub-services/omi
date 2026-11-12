import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { PAGE_HTML } from "../../../../tools/coordinator/watch-page.ts";
import { buildTasks, diagramNodes, cyclePhase } from "../../../../tools/coordinator/watch-tasks.ts";
import { loadTemplate } from "../../../../tools/coordinator/watch-workflow.ts";
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
    const wide = diagramNodes(
      "Review",
      cyclePhase(
        ["F", "F", "A", "F", "F"].map((c) => ({
          author: "minibox-claude-code",
          body: c === "F" ? "**VERDICT:** FAIL" : "**ARCHITECT:** why",
        })),
      ),
    );
    expect(wide.map((n) => n.id)).toEqual(expect.arrayContaining(["Architect", "Ask PO"]));
    for (const n of wide) expect(js).toContain(`"${n.id}"`);
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
  const FAIL = (sha = "1111111") => comment(`**VERDICT:** FAIL\n**REVIEWED_HEAD:** ${sha}`);
  const ARCH = () => comment("**ARCHITECT:** rethink the seam");
  const viewOf = (
    comments: { author: string; body: string }[],
    running = false,
    workflow: string | null = "feature",
    extra: Record<string, unknown> = {},
  ) =>
    buildTasks({
      workers: {
        available: true,
        latestLog: null,
        processes: running
          ? [
              {
                pid: 1,
                tool: "codex",
                headless: true,
                elapsedSeconds: 5,
                task: "OMI-074",
                profile: "p",
              },
            ]
          : [],
      },
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
            workflow,
            role: "Developer",
            area: null,
            milestone: null,
            blockers: [],
            blockersTruncated: false,
            ...extra,
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
            comments,
            checks: [],
          },
        ],
        prompts: { "OMI-074": { skills: ["minimal-change"], rules: ["AGENTS.md"] } },
      },
    });

  // What the diagram shows: title, node labels with state, edges, badge.
  const diagram = (comments: { author: string; body: string }[], running = false) => {
    const all = renderInDom(viewOf(comments, running)).all();
    const svg = all.find((n) => n.tag === "svg");
    const groups = all.filter((n) => n.tag === "g" && (n.attrs.class ?? "").startsWith("n "));
    return {
      title: all.find((n) => n.className === "wf")?.textContent,
      aria: svg?.attrs["aria-label"],
      viewBox: svg?.attrs.viewBox,
      nodes: groups.map(
        (g) => `${g.children[1]?.textContent ?? "?"}:${(g.attrs.class ?? "").slice(2)}`,
      ),
      work: groups.find((g) => g.children[1]?.textContent === "Work")?.children[2]?.textContent,
      back: all.filter((n) => n.tag === "path" && (n.attrs.class ?? "").includes("back")).length,
      ask: all.filter((n) => n.tag === "path" && (n.attrs.class ?? "").includes("ask")).length,
      badge: all.find((n) => n.attrs.class === "badge")?.children[1]?.textContent,
      note: all.map((n) => n.textContent).find((t) => t.startsWith("Cycle:")),
      text: all.map((n) => n.textContent),
    };
  };
  const MAIN_TODO = ["Merge:todo", "Done:todo"];

  it("0 FAILs: workflow title, main row only, no Rework node, no back edge, no x0 badge", () => {
    const d = diagram([]);
    expect(d.title).toBe("Workflow: feature");
    expect(d.aria).toBe("OMI-074: Workflow: feature, current step Review");
    expect(d.viewBox).toBe("0 0 540 124");
    expect(d.nodes).toEqual([
      "Start:done",
      "Work:done",
      "Verify/PR:done",
      "Review:cur",
      ...MAIN_TODO,
    ]);
    expect(d.back).toBe(0);
    expect(d.badge).toBeUndefined();
    expect(d.text.some((t) => t.includes("×0"))).toBe(false);
    expect(d.text).not.toContain("Rework");
  });

  it("draws the standing node as blocked with a sub-label and lists the blockers on the card", () => {
    const all = renderInDom(
      viewOf([], false, "feature", {
        status: "In Progress",
        blockers: [
          { number: 158, state: "OPEN" },
          { number: 9, state: "CLOSED" },
        ],
      }),
    ).all();
    const groups = all.filter((n) => n.tag === "g" && (n.attrs.class ?? "").startsWith("n "));
    const node = groups.find((g) => g.children[1]?.textContent === "Verify/PR");
    expect(node?.attrs.class).toBe("n blocked");
    expect(node?.children[2]?.textContent).toBe("blocked by #158");
    expect(all.some((n) => n.textContent === "Step: Blocked")).toBe(true);
    expect(all.map((n) => n.textContent)).toContain("Blockers: #158 (open), #9 (closed)");
  });

  it("labels a Waiting PO node with waiting PO and shows the reason", () => {
    const all = renderInDom(
      viewOf([], false, "feature", {
        status: "In Progress",
        comments: [comment("**WAITING-PO:** run live")],
      }),
    ).all();
    const groups = all.filter((n) => n.tag === "g" && (n.attrs.class ?? "").startsWith("n "));
    const node = groups.find((g) => (g.attrs.class ?? "") === "n blocked");
    expect(node?.children[2]?.textContent).toBe("waiting PO");
    expect(all.map((n) => n.textContent)).toContain("run live");
  });

  it("shows Workflow: - when the Project field is missing", () => {
    const all = renderInDom(viewOf([], false, null)).all();
    expect(all.find((n) => n.className === "wf")?.textContent).toBe("Workflow: -");
  });

  it("1 FAIL: Work is current with rework 1/2 and one Review -> Work edge labelled FAIL x1", () => {
    const d = diagram([FAIL(head.slice(0, 7))]);
    expect(d.nodes).toEqual([
      "Start:done",
      "Work:cur",
      "Verify/PR:todo",
      "Review:todo",
      ...MAIN_TODO,
    ]);
    expect(d.work).toBe("rework 1/2");
    expect(d.back).toBe(1);
    expect(d.badge).toBe("FAIL ×1");
    expect(d.aria).toBe("OMI-074: Workflow: feature, current step Work, rework 1/2");
    expect(d.note).toBe("Cycle: rework 1/2");
  });

  it("2 FAILs, no marker: Architect appears on the return path with a warning outline", () => {
    const d = diagram([FAIL(), FAIL(head.slice(0, 7))]);
    expect(d.nodes).toContain("Architect:warn");
    expect(d.nodes).not.toContain("Ask PO:warn");
    expect(d.back).toBe(2);
    expect(d.badge).toBe("FAIL ×2");
    expect(d.work).toBe("rework 2/2");
    expect(d.note).toBe("Cycle: call the Architect (2 FAILs, no ARCHITECT marker)");
  });

  it("2 FAILs and the marker: Architect is lit while Work runs again", () => {
    const d = diagram([FAIL(), FAIL(), ARCH()], true);
    expect(d.nodes).toContain("Architect:lit");
    expect(d.nodes).toContain("Work:cur");
    expect(d.work).toBe("rework 0/2");
    expect(d.back).toBe(2);
    expect(d.note).toBe("Cycle: Architect called, rework 0/2 after Architect");
  });

  it("2 FAILs and the marker with no worker yet: Architect is the current node", () => {
    const d = diagram([FAIL(), FAIL(head.slice(0, 7)), ARCH()]);
    expect(d.nodes).toContain("Architect:cur");
    expect(d.nodes).toContain("Review:done");
    expect(d.nodes).toContain("Work:done");
  });

  it("3 FAILs: rework 1/2 after Architect, Architect lit, no Ask PO", () => {
    const d = diagram([FAIL(), FAIL(), ARCH(), FAIL(head.slice(0, 7))]);
    expect(d.nodes).toContain("Architect:lit");
    expect(d.nodes).toContain("Work:cur");
    expect(d.work).toBe("rework 1/2");
    expect(d.badge).toBe("FAIL ×3");
    expect(d.ask).toBe(0);
    expect(d.note).toBe("Cycle: rework 1/2 (after Architect)");
  });

  it("4 FAILs: Ask PO warning and no further loop", () => {
    const d = diagram([FAIL(), FAIL(), ARCH(), FAIL(), FAIL(head.slice(0, 7))]);
    expect(d.nodes).toContain("Ask PO:warn");
    expect(d.nodes).toContain("Architect:lit");
    expect(d.ask).toBe(1);
    expect(d.back).toBe(2);
    expect(d.badge).toBe("FAIL ×4");
    expect(d.note).toBe("Cycle: 2 FAILs after Architect, ask the PO");
  });

  it("puts external strings in textContent or attributes, never as markup", () => {
    const text = renderInDom(viewOf([FAIL(), FAIL(head.slice(0, 7))]))
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

describe("watch page, template diagram (OMI-088)", () => {
  const tasksFor = async (workflow: string, skills: string[], status = "In Progress") => {
    const template = await loadTemplate(workflow);
    return buildTasks({
      workers: {
        available: true,
        latestLog: null,
        processes: [
          {
            pid: 1,
            tool: "codex",
            headless: true,
            elapsedSeconds: 5,
            task: "OMI-074",
            profile: "p",
          },
        ],
      },
      tasks: {
        available: true,
        items: [
          {
            kind: "Issue",
            number: 152,
            title: "t",
            state: "OPEN",
            status,
            priority: "P1",
            workType: "Task",
            planKey: "OMI-074",
            body: "",
            workflow,
            role: "Developer",
            area: null,
            milestone: null,
            blockers: [],
            blockersTruncated: false,
          },
        ],
        pulls: [],
        prompts: { "OMI-074": { skills, rules: ["AGENTS.md"] } },
        templates: { [workflow]: template },
      },
    });
  };
  const nodesOf = (app: ReturnType<typeof renderInDom>) =>
    app
      .all()
      .filter((n) => n.tag === "g" && (n.attrs.class ?? "").startsWith("n "))
      .map((g) => `${g.children[1]?.textContent ?? "?"}:${(g.attrs.class ?? "").slice(2)}`);
  const texts = (app: ReturnType<typeof renderInDom>) => app.all().map((n) => n.textContent);

  it("draws the template's steps and gates with their roles, and the lifecycle viewBox is unchanged elsewhere", async () => {
    const app = renderInDom(await tasksFor("feature", ["minimal-change"]));
    expect(nodesOf(app)).toEqual([
      "analyze:done",
      "scope-approved:done",
      "implement:cur",
      "verify:todo",
      "review:todo",
      "ready-to-merge:todo",
    ]);
    const t = texts(app);
    expect(t).toContain("developer");
    expect(t).toContain("Workflow: feature");
    expect(t).toContain("Step: Work (implement)");
    expect(t).toContain("Role: developer");
  });

  it("lays out the 7 nodes of bugfix inside the viewBox", async () => {
    const app = renderInDom(await tasksFor("bugfix", []));
    const svg = app.all().find((n) => n.tag === "svg");
    const [, , w] = (svg?.attrs.viewBox ?? "").split(" ").map(Number);
    const rects = app.all().filter((n) => n.tag === "rect" && n.attrs.width === "116");
    expect(rects.length).toBe(7);
    for (const r of rects)
      expect(Number(r.attrs.x) + Number(r.attrs.width)).toBeLessThanOrEqual(w ?? 0);
  });

  it("selecting a node shows its template skills and rules", async () => {
    const app = renderInDom(await tasksFor("feature", ["minimal-change"]));
    const verify = app
      .all()
      .find((n) => n.tag === "g" && n.children[1]?.textContent === "verify") as unknown as {
      onclick: () => void;
    };
    verify.onclick();
    const t = texts(app).join("\n");
    expect(t).toContain("verify · qa");
    expect(t).toContain("skills: verification-before-completion");
    expect(t).toContain("rules: project-baseline, approval-gates, evidence-and-tests");
  });

  it("marks the loaded skills that differ from the template step", async () => {
    const app = renderInDom(
      await tasksFor("feature", ["test-driven-development", "verification-before-completion"]),
    );
    const t = texts(app);
    expect(t).toContain("Template skills (implement): test-driven-development, minimal-change");
    expect(t).toContain(
      "≠ loaded, but the template gives it to verify: verification-before-completion",
    );
    expect(t).toContain("≠ in the template step, not loaded: minimal-change");
    const ok = renderInDom(
      await tasksFor("feature", ["test-driven-development", "minimal-change"]),
    );
    expect(texts(ok)).toContain("Skills match the template step");
  });

  it("explains the lifecycle fallback on the card", () => {
    const view = buildTasks({
      workers: { available: true, latestLog: null, processes: [] },
      tasks: {
        available: true,
        items: [
          {
            kind: "Issue",
            number: 1,
            title: "t",
            state: "OPEN",
            status: "In Progress",
            priority: "P1",
            workType: "Task",
            planKey: "OMI-074",
            body: "",
            workflow: "nope",
            role: null,
            area: null,
            milestone: null,
            blockers: [],
            blockersTruncated: false,
          },
        ],
        pulls: [],
        prompts: { "OMI-074": { skills: [], rules: [] } },
        templates: { nope: { ok: false, reason: 'no template for Workflow "nope"' } },
      },
    });
    const app = renderInDom(view);
    expect(nodesOf(app)[0]).toBe("Start:done");
    expect(texts(app)).toContain('Template: no template for Workflow "nope" (lifecycle shown)');
  });
});
