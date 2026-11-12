import { describe, expect, it } from "vitest";
import { COORDINATOR_LOGIN } from "../../../../tools/coordinator/coordinator-settings.ts";
import type { OpenPull, ProjectItem } from "../../../../tools/coordinator/github-snapshot.ts";
import type { Command } from "../../../../tools/coordinator/process-runner.ts";
import {
  buildTasks,
  countRework,
  cyclePhase,
  deriveStep,
  detectArchitect,
  diagramNodes,
  parsePromptProbe,
  parsePromptText,
  readPrompts,
  taskLine,
  type StepInput,
  type TasksRead,
} from "../../../../tools/coordinator/watch-tasks.ts";
import { loadTemplate } from "../../../../tools/coordinator/watch-workflow.ts";
import type { WorkerProcess, Workers } from "../../../../tools/coordinator/wsl-workers.ts";

const HEAD = "abc1234def5678abc1234def5678abc1234def56";
const OLD = "0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const verdict = (v: string, head = HEAD.slice(0, 7)) =>
  `Review done.\n**VERDICT:** ${v}\n**REVIEWED_HEAD:** ${head}\n`;
const by = (author: string | null, body: string) => ({ author, body });
const coord = (body: string) => by(COORDINATOR_LOGIN, body);
const pull = (comments: { author: string | null; body: string }[] = []) => ({
  headRefOid: HEAD,
  comments,
});
const base: StepInput = {
  status: "In Progress",
  worker: { kind: "none" },
  pull: null,
  dispatched: true,
};
const step = (over: Partial<StepInput>) => deriveStep({ ...base, ...over });

describe("countRework / detectArchitect", () => {
  it("counts only Coordinator-account VERDICT FAIL comments", () => {
    const comments = [
      coord(verdict("FAIL", OLD.slice(0, 7))),
      by("someone-else", verdict("FAIL")),
      by(null, verdict("FAIL")),
      coord(verdict("PASS")),
      coord(verdict("FAIL")),
      coord("quoting: the old text said VERDICT: FAIL inside a sentence"),
    ];
    expect(countRework(comments)).toBe(2);
    expect(countRework([])).toBe(0);
  });

  it("detects the **ARCHITECT:** marker from the Coordinator only, with its reason", () => {
    expect(detectArchitect([])).toEqual({ called: false, reason: null });
    expect(detectArchitect([by("someone-else", "**ARCHITECT:** nope")])).toEqual({
      called: false,
      reason: null,
    });
    expect(detectArchitect([coord("**ARCHITECT:**")])).toEqual({ called: false, reason: null });
    expect(
      detectArchitect([coord("notes\n**ARCHITECT:** two FAILs on the same seam\nmore")]),
    ).toEqual({ called: true, reason: "two FAILs on the same seam" });
  });
});

describe("deriveStep", () => {
  it("Done", () => {
    expect(step({ status: "Done" })).toEqual({ step: "Done", reason: null });
  });

  it("Start: In Progress, no worker, no PR, never dispatched", () => {
    expect(step({ dispatched: false }).step).toBe("Start");
  });

  it("Work: a worker process runs for the task", () => {
    expect(step({ worker: { kind: "running" } }).step).toBe("Work");
    expect(step({ worker: { kind: "running" }, pull: pull() }).step).toBe("Work");
  });

  it("Verify/PR: In Progress, no worker, dispatched, no PR or a PR with no review", () => {
    expect(step({}).step).toBe("Verify/PR");
    expect(step({ pull: pull() }).step).toBe("Verify/PR");
    // a FAIL on an older head only: new commits are waiting for the next review
    expect(step({ pull: pull([coord(verdict("FAIL", OLD.slice(0, 7)))]) }).step).toBe("Verify/PR");
  });

  it("Review: In Review with no VERDICT on the current head", () => {
    expect(step({ status: "In Review", pull: pull() }).step).toBe("Review");
    expect(
      step({ status: "In Review", pull: pull([coord(verdict("PASS", OLD.slice(0, 7)))]) }).step,
    ).toBe("Review");
  });

  it("ignores a PASS or FAIL from another account", () => {
    expect(
      step({ status: "In Review", pull: pull([by("someone-else", verdict("PASS"))]) }).step,
    ).toBe("Review");
  });

  it("Rework: the newest VERDICT on the head is FAIL, or a worker runs again after a FAIL", () => {
    const failed = pull([coord(verdict("FAIL"))]);
    expect(step({ status: "In Review", pull: failed }).step).toBe("Rework");
    expect(step({ pull: failed }).step).toBe("Rework");
    expect(step({ worker: { kind: "running" }, pull: failed }).step).toBe("Rework");
    // a FAIL on an old head still means the worker is reworking
    expect(
      step({ worker: { kind: "running" }, pull: pull([coord(verdict("FAIL", OLD.slice(0, 7)))]) })
        .step,
    ).toBe("Rework");
  });

  it("Architect: the Coordinator called it after the latest FAIL and no worker runs yet", () => {
    const called = pull([coord(verdict("FAIL")), coord("**ARCHITECT:** fix the seam")]);
    expect(step({ status: "In Review", pull: called }).step).toBe("Architect");
    // an ARCHITECT comment before the latest FAIL does not make it the current step
    const earlier = pull([coord("**ARCHITECT:** why"), coord(verdict("FAIL"))]);
    expect(step({ status: "In Review", pull: earlier }).step).toBe("Rework");
    // the worker runs again: Rework, not Architect
    expect(step({ worker: { kind: "running" }, pull: called }).step).toBe("Rework");
  });

  it("Merge: PASS on the head", () => {
    expect(step({ status: "In Review", pull: pull([coord(verdict("PASS"))]) }).step).toBe("Merge");
    const afterFail = pull([coord(verdict("FAIL")), coord(verdict("PASS"))]);
    expect(step({ status: "In Review", pull: afterFail }).step).toBe("Merge");
  });

  it("unknown with a reason when nothing can be derived", () => {
    expect(step({ status: null })).toEqual({
      step: "unknown",
      reason: "Status is not In Progress or In Review",
    });
    expect(step({ status: "Blocked" }).reason).toContain("Blocked");
    expect(step({ worker: { kind: "unknown", reason: "WSL unavailable: off" } })).toEqual({
      step: "unknown",
      reason: "workers unreadable: WSL unavailable: off",
    });
    expect(step({ dispatched: null }).reason).toContain("dispatch");
    expect(step({ status: "In Review" }).reason).toContain("no open PR");
    expect(step({ status: "In Review", pull: pull([coord(verdict("BLOCKED"))]) }).reason).toContain(
      "BLOCKED",
    );
  });

  it("a decisive VERDICT on the head wins over unreadable workers", () => {
    const unreadable = { kind: "unknown", reason: "off" } as const;
    expect(
      step({ worker: unreadable, status: "In Review", pull: pull([coord(verdict("PASS"))]) }).step,
    ).toBe("Merge");
    expect(
      step({ worker: unreadable, status: "In Review", pull: pull([coord(verdict("FAIL"))]) }).step,
    ).toBe("Rework");
  });
});

describe("cyclePhase (2 + Architect + 2)", () => {
  const f = () => coord(verdict("FAIL"));
  const arch = () => coord("**ARCHITECT:** fix the seam");
  const phase = (...c: { author: string | null; body: string }[]) => cyclePhase(c);

  it("before-architect: 0 and 1 FAILs count k/2", () => {
    expect(phase()).toEqual({ phase: "before-architect", fails: 0, k: 0, architectCalled: false });
    expect(phase(f())).toEqual({
      phase: "before-architect",
      fails: 1,
      k: 1,
      architectCalled: false,
    });
  });

  it("architect: the 2nd FAIL needs the Architect, and stays so at 3 FAILs without a marker", () => {
    expect(phase(f(), f())).toEqual({ phase: "architect", fails: 2, k: 2, architectCalled: false });
    expect(phase(f(), f(), f())).toMatchObject({
      phase: "architect",
      fails: 3,
      architectCalled: false,
    });
  });

  it("architect: a marker after 2 FAILs means it was called and no rework ran after it yet", () => {
    expect(phase(f(), f(), arch())).toEqual({
      phase: "architect",
      fails: 2,
      k: 0,
      architectCalled: true,
    });
  });

  it("after-architect: counts only FAILs after the marker, k/2", () => {
    expect(phase(f(), f(), arch(), f())).toEqual({
      phase: "after-architect",
      fails: 3,
      k: 1,
      architectCalled: true,
    });
  });

  it("escalate-po: the 2nd FAIL after the marker, and any later FAIL", () => {
    expect(phase(f(), f(), arch(), f(), f())).toEqual({
      phase: "escalate-po",
      fails: 4,
      k: 2,
      architectCalled: true,
    });
    expect(phase(f(), f(), arch(), f(), f(), f())).toMatchObject({
      phase: "escalate-po",
      fails: 5,
    });
  });

  it("ignores FAIL and marker comments of other accounts", () => {
    const other = (body: string) => by("someone-else", body);
    expect(phase(f(), other(verdict("FAIL")), other("**ARCHITECT:** nope"))).toMatchObject({
      phase: "before-architect",
      fails: 1,
      architectCalled: false,
    });
    expect(phase(f(), f(), other("**ARCHITECT:** nope"), by(null, verdict("FAIL")))).toMatchObject({
      phase: "architect",
      architectCalled: false,
    });
    expect(phase(f(), f(), arch(), other(verdict("FAIL")), other(verdict("FAIL")))).toMatchObject({
      phase: "architect",
      k: 0,
      architectCalled: true,
    });
  });

  it("a marker without a reason does not count", () => {
    expect(phase(f(), f(), coord("**ARCHITECT:**"))).toMatchObject({ architectCalled: false });
  });

  it("a marker before any FAIL counts as the call: lit at 0 FAILs, then FAILs count after it", () => {
    expect(phase(arch())).toEqual({
      phase: "architect",
      fails: 0,
      k: 0,
      architectCalled: true,
    });
    expect(phase(arch(), f())).toMatchObject({ phase: "after-architect", fails: 1, k: 1 });
    expect(phase(arch(), f(), f())).toMatchObject({ phase: "escalate-po", fails: 2, k: 2 });
  });

  it("uses the first marker, so a second call does not give two more reworks", () => {
    expect(phase(f(), f(), arch(), f(), arch(), f())).toMatchObject({ phase: "escalate-po" });
  });

  it("a FAIL and the marker in one comment: the FAIL comes first", () => {
    expect(phase(f(), coord(verdict("FAIL") + "**ARCHITECT:** two FAILs"))).toMatchObject({
      phase: "architect",
      fails: 2,
      k: 0,
      architectCalled: true,
    });
  });
});

describe("diagramNodes", () => {
  // "F" = Coordinator FAIL, "A" = Coordinator **ARCHITECT:** marker, oldest first
  const ph = (seq: string) =>
    cyclePhase(Array.from(seq, (ch) => coord(ch === "F" ? verdict("FAIL") : "**ARCHITECT:** why")));
  const states = (s: Parameters<typeof diagramNodes>[0], cycle = ph("")) =>
    Object.fromEntries(diagramNodes(s, cycle).map((n) => [n.id, n.state]));

  it("has a text label for every node, in lifecycle order, and no separate Rework node", () => {
    const nodes = diagramNodes("Start", ph(""));
    expect(nodes.map((n) => n.id)).toEqual([
      "Start",
      "Work",
      "Verify/PR",
      "Review",
      "Merge",
      "Done",
    ]);
    expect(nodes.every((n) => n.label.length > 0)).toBe(true);
    expect(diagramNodes("Rework", ph("F")).some((n) => n.id === "Rework")).toBe(false);
  });

  it("marks past nodes done and the current one current", () => {
    expect(states("Verify/PR")).toMatchObject({
      Start: "done",
      Work: "done",
      "Verify/PR": "current",
      Review: "todo",
      Merge: "todo",
      Done: "todo",
    });
    expect(states("Done")).toMatchObject({ Merge: "done", Done: "current" });
  });

  it("rework makes Work current with a rework k/2 sub-label", () => {
    const nodes = diagramNodes("Rework", ph("F"));
    expect(Object.fromEntries(nodes.map((n) => [n.id, n.state]))).toMatchObject({
      Start: "done",
      Work: "current",
      "Verify/PR": "todo",
      Review: "todo",
      Merge: "todo",
    });
    expect(nodes.find((n) => n.id === "Work")?.sub).toBe("rework 1/2");
    expect(diagramNodes("Work", ph("")).find((n) => n.id === "Work")?.sub).toBeUndefined();
    expect(diagramNodes("Review", ph("F")).find((n) => n.id === "Work")?.sub).toBeUndefined();
  });

  it("shows the Architect node only from the 2nd FAIL or a marker", () => {
    const ids = (s: Parameters<typeof diagramNodes>[0], c: ReturnType<typeof ph>) =>
      diagramNodes(s, c).map((n) => n.id);
    expect(ids("Review", ph(""))).not.toContain("Architect");
    expect(ids("Rework", ph("F"))).not.toContain("Architect");
    expect(ids("Review", ph("FF"))).toContain("Architect");
    expect(ids("Review", ph("A"))).toContain("Architect");
  });

  it("Architect warns without a marker, is lit with one, current when it is the step", () => {
    expect(states("Review", ph("FF")).Architect).toBe("warn");
    expect(states("Rework", ph("FFF")).Architect).toBe("warn");
    expect(states("Rework", ph("FFA")).Architect).toBe("lit");
    expect(states("Architect", ph("FFA"))).toMatchObject({
      Review: "done",
      Work: "done",
      Architect: "current",
    });
  });

  it("after the Architect, Work is rework k/2 and Ask PO appears only at the 2nd FAIL after it", () => {
    const after = diagramNodes("Rework", ph("FFAF"));
    expect(after.find((n) => n.id === "Work")?.sub).toBe("rework 1/2");
    expect(after.some((n) => n.id === "Ask PO")).toBe(false);
    const esc = diagramNodes("Rework", ph("FFAFF"));
    expect(esc.find((n) => n.id === "Ask PO")?.state).toBe("warn");
    expect(esc.find((n) => n.id === "Work")?.sub).toBe("rework 2/2");
    expect(esc.find((n) => n.id === "Architect")?.state).toBe("lit");
  });

  it("unknown highlights nothing", () => {
    expect(Object.values(states("unknown")).includes("current")).toBe(false);
  });
});

describe("parsePromptText", () => {
  const prompt = [
    "# Task",
    "Read `AGENTS.md`, docs/architecture/architecture.md and docs/architecture/adr/0014-coordinator.md.",
    "See also docs/architecture/architecture.md and CLAUDE.md. Not docs/arch/*.md.",
    "## Skill: test-driven-development (follow it; report it under Skills applied)",
    "body mentioning ## Skill: not-a-heading",
    "## Skill: minimal-change (follow it)",
    "## Skill: ../../evil\u001b[2J",
  ].join("\n");

  it("reads skills from `## Skill:` headings and rule files the prompt mentions", () => {
    expect(parsePromptText(prompt)).toEqual({
      skills: ["test-driven-development", "minimal-change"],
      rules: [
        "AGENTS.md",
        "CLAUDE.md",
        "docs/architecture/adr/0014-coordinator.md",
        "docs/architecture/architecture.md",
      ],
    });
  });

  it("returns empty lists for a prompt with neither", () => {
    expect(parsePromptText("hello")).toEqual({ skills: [], rules: [] });
  });
});

describe("parsePromptProbe / readPrompts", () => {
  it("maps each requested task to its prompt info, null for a missing file", () => {
    const out = [
      "@@prompt 074",
      "## Skill: minimal-change",
      "AGENTS.md",
      "@@missing 073",
      "@@prompt 075",
    ].join("\n");
    expect(parsePromptProbe(out)).toEqual({
      "OMI-074": { skills: ["minimal-change"], rules: ["AGENTS.md"] },
      "OMI-073": null,
      "OMI-075": { skills: [], rules: [] },
    });
  });

  it("runs one WSL command for validated plan keys and degrades to {} on failure", async () => {
    const seen: Command[] = [];
    const ok = await readPrompts(
      (c) => {
        seen.push(c);
        return Promise.resolve({ code: 0, stdout: "@@missing 074\n", stderr: "" });
      },
      { viaWslExe: false, distro: "d", repoDir: "/r" },
      ["OMI-074", "OMI-074; rm -rf /", "EP-1"],
    );
    expect(ok).toEqual({ "OMI-074": null });
    expect(seen).toHaveLength(1);
    const payload = seen[0]?.args.at(-1) ?? "";
    expect(payload).toContain("omi-$n-prompt.md");
    expect(payload).toContain("074");
    expect(payload).not.toContain("rm -rf");
    const none = await readPrompts(
      () => Promise.resolve({ code: 1, stdout: "", stderr: "x" }),
      { viaWslExe: false, distro: "d", repoDir: "/r" },
      ["OMI-074"],
    );
    expect(none).toBeNull();
    const idle = await readPrompts(
      () => Promise.reject(new Error("must not run")),
      { viaWslExe: false, distro: "d", repoDir: "/r" },
      [],
    );
    expect(idle).toEqual({});
  });
});

const item = (over: Partial<ProjectItem> = {}): ProjectItem => ({
  kind: "Issue",
  number: 152,
  title: "[OMI-074] Tasks\nview",
  state: "OPEN",
  status: "In Progress",
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
  ...over,
});
const openPull = (over: Partial<OpenPull> = {}): OpenPull => ({
  number: 160,
  title: "t",
  isDraft: false,
  headRefName: "task/omi-074-watch-tasks",
  headRefOid: HEAD,
  baseRefName: "develop",
  body: "Issue: #152",
  reviewDecision: null,
  mergeStateStatus: "CLEAN",
  comments: [],
  checks: [{ name: "check", state: "pass" }],
  ...over,
});
const worker: WorkerProcess = {
  pid: 9,
  tool: "claude",
  headless: true,
  elapsedSeconds: 61.9,
  task: "OMI-074",
  profile: "minibox",
  model: "opus-5-5",
  effort: "high",
  log: {
    numTurns: 12,
    lastAction: "Bash\u001b[2J npm test",
    finished: false,
    isError: false,
    limited: false,
  },
};
const available = (processes: WorkerProcess[]): Workers => ({
  available: true,
  processes,
  latestLog: null,
});
const read = (over: Partial<Extract<TasksRead, { available: true }>> = {}): TasksRead => ({
  available: true,
  items: [item()],
  pulls: [],
  prompts: { "OMI-074": { skills: ["minimal-change"], rules: ["AGENTS.md"] } },
  ...over,
});

describe("buildTasks", () => {
  it("is loading before the first GitHub read and carries an unavailable reason", () => {
    expect(buildTasks({ tasks: null, workers: null })).toEqual({ state: "loading" });
    expect(
      buildTasks({ tasks: { available: false, reason: "gh\nfailed" }, workers: null }),
    ).toEqual({ state: "unavailable", reason: "gh failed" });
  });

  it("builds one card for a task In Progress with its worker, role, skills and rules", () => {
    const view = buildTasks({ tasks: read(), workers: available([worker]) });
    if (view.state !== "ok") throw new Error("expected ok");
    expect(view.items).toHaveLength(1);
    const t = view.items[0];
    expect(t).toMatchObject({
      planKey: "OMI-074",
      issue: 152,
      title: "[OMI-074] Tasks view",
      workflow: "Development",
      priority: "P1",
      step: "Work",
      stepReason: null,
      role: "Developer",
      rework: 0,
      cycle: { phase: "before-architect", fails: 0, k: 0, architectCalled: false },
      pr: null,
      skills: ["minimal-change"],
      skillsNote: null,
      worker: {
        tool: "claude",
        profile: "minibox",
        model: "opus-5-5",
        effort: "high",
        elapsedSeconds: 61,
        turns: 12,
        lastAction: "Bash [2J npm test",
      },
    });
    expect(t?.rules).toEqual(
      expect.arrayContaining(["AGENTS.md", "no push, PR or merge", "gh is read-only"]),
    );
    expect(t?.ariaLabel).toBe("OMI-074: Workflow: Development, current step Work");
    expect(t?.nodes.find((n) => n.state === "current")?.id).toBe("Work");
  });

  it("shows the PR number, short head and checks, rework count and the Architect", () => {
    const comments = [
      coord(verdict("FAIL", OLD.slice(0, 7))),
      coord(verdict("FAIL")),
      coord("**ARCHITECT:** rethink"),
    ];
    const view = buildTasks({
      tasks: read({ items: [item({ status: "In Review" })], pulls: [openPull({ comments })] }),
      workers: available([]),
    });
    if (view.state !== "ok") throw new Error("expected ok");
    expect(view.items[0]).toMatchObject({
      pr: { number: 160, head: "abc1234", checks: "pass" },
      step: "Architect",
      role: "Architect",
      rework: 2,
      cycle: { phase: "architect", architectCalled: true },
      worker: null,
    });
  });

  it("warns when two FAILs have no Architect and gives Review the Reviewer role", () => {
    const failed = [coord(verdict("FAIL", OLD.slice(0, 7))), coord(verdict("FAIL", "1111111"))];
    const view = buildTasks({
      tasks: read({
        items: [item({ status: "In Review" })],
        pulls: [openPull({ comments: failed })],
      }),
      workers: available([]),
    });
    if (view.state !== "ok") throw new Error("expected ok");
    expect(view.items[0]).toMatchObject({
      step: "Review",
      role: "Reviewer",
      cycle: { phase: "architect", architectCalled: false },
    });
  });

  it("uses '-' with a reason when data is missing", () => {
    const view = buildTasks({
      tasks: read({ prompts: {}, items: [item({ workflow: null, role: null, planKey: null })] }),
      workers: null,
    });
    if (view.state !== "ok") throw new Error("expected ok");
    expect(view.items[0]).toMatchObject({
      workflow: "-",
      role: "-",
      planKey: "-",
      step: "unknown",
      skills: [],
      rules: [],
      worker: null,
    });
    expect(view.items[0]?.skillsNote).toContain("no prompt");
    expect(view.items[0]?.stepReason).toBeTruthy();
  });

  it("only lists open Issues In Progress / In Review, in-progress first, then by priority", () => {
    const view = buildTasks({
      tasks: read({
        prompts: {},
        items: [
          item({ number: 5, planKey: "OMI-005", status: "In Review", priority: "P0" }),
          item({ number: 4, planKey: "OMI-004", status: "In Progress", priority: "P1" }),
          item({ number: 3, planKey: "OMI-003", status: "Ready" }),
          item({ number: 2, planKey: "OMI-002", status: "In Progress", state: "CLOSED" }),
          item({ number: 1, planKey: "OMI-001", status: "In Progress", priority: "P0" }),
          item({ kind: "DraftIssue", number: null, status: "In Progress" }),
        ],
      }),
      workers: available([]),
    });
    if (view.state !== "ok") throw new Error("expected ok");
    expect(view.items.map((t) => t.planKey)).toEqual(["OMI-001", "OMI-004", "OMI-005"]);
  });

  it("matches the PR by the Issue link or the branch name, and is JSON-serialisable", () => {
    const byBranch = openPull({ body: "", number: 7 });
    const other = openPull({ body: "Issue: #999", headRefName: "task/omi-001-x", number: 8 });
    const view = buildTasks({
      tasks: read({ pulls: [other, byBranch] }),
      workers: available([]),
    });
    if (view.state !== "ok") throw new Error("expected ok");
    expect(view.items[0]?.pr?.number).toBe(7);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });
});

describe("taskLine", () => {
  const first = () => {
    const view = buildTasks({ tasks: read(), workers: available([worker]) });
    if (view.state !== "ok" || !view.items[0]) throw new Error("expected ok");
    return view.items[0];
  };

  it("prints OMI-NNN workflow step phase role tool/profile on one line", () => {
    expect(taskLine(first())).toBe("OMI-074 Development Work rework:0/2 Developer claude/minibox");
    expect(taskLine({ ...first(), worker: null, step: "Review", role: "Reviewer" })).toBe(
      "OMI-074 Development Review rework:0/2 Reviewer -/-",
    );
  });

  it("names the phase: rework k/2, architect needed or called, after-architect k/2, ask-po", () => {
    const line = (comments: { author: string | null; body: string }[]) => {
      const view = buildTasks({
        tasks: read({ pulls: [openPull({ comments })] }),
        workers: available([worker]),
      });
      if (view.state !== "ok" || !view.items[0]) throw new Error("expected ok");
      return taskLine(view.items[0]);
    };
    const f = coord(verdict("FAIL"));
    const a = coord("**ARCHITECT:** why");
    expect(line([f])).toBe("OMI-074 Development Work rework:1/2 Developer claude/minibox");
    expect(line([f, f])).toContain(" architect:needed ");
    expect(line([f, f, a])).toContain(" architect:called ");
    expect(line([f, f, a, f])).toContain(" after-architect:1/2 ");
    expect(line([f, f, a, f, f])).toContain(" ask-po ");
  });
});

describe("Blocked and Waiting PO (OMI-086)", () => {
  const open = (n: number) => ({ number: n, state: "OPEN" });
  const closed = (n: number) => ({ number: n, state: "CLOSED" });
  const wait = (reason = "run the live check") => coord(`**WAITING-PO:** ${reason}`);

  it("Blocked: an open blocker and no worker; the reason lists the open blockers only", () => {
    expect(step({ blockers: [open(158), closed(9), open(160)] })).toMatchObject({
      step: "Blocked",
      reason: "blocked by #158, #160",
      at: "Verify/PR",
    });
    expect(step({ dispatched: false, blockers: [open(1)] }).at).toBe("Start");
  });

  it("is not Blocked when every blocker is closed", () => {
    expect(step({ blockers: [closed(158)] }).step).toBe("Verify/PR");
  });

  it("Work with a warning while a worker runs and a blocker is open", () => {
    expect(step({ worker: { kind: "running" }, blockers: [open(158)] })).toEqual({
      step: "Work",
      reason: "worker runs but blocked by #158",
    });
    expect(step({ worker: { kind: "running" }, blockers: [closed(158)] }).reason).toBeNull();
  });

  it("Waiting PO: the newest Coordinator comment on the Issue starts with the marker", () => {
    expect(step({ issueComments: [wait()] })).toMatchObject({
      step: "Waiting PO",
      reason: "run the live check",
      at: "Verify/PR",
    });
  });

  it("Waiting PO on the PR comments too; a newer Coordinator comment clears it", () => {
    expect(step({ status: "In Review", pull: pull([wait("why")]) }).step).toBe("Waiting PO");
    expect(step({ pull: pull([wait(), coord("PO answered, continue")]) }).step).toBe("Verify/PR");
    expect(step({ issueComments: [wait()], pull: pull([coord("back to work")]) }).step).toBe(
      "Verify/PR",
    );
    expect(step({ issueComments: [wait(), coord("continuing")] }).step).toBe("Verify/PR");
  });

  it("ignores the marker from another account and a newer comment from another account", () => {
    expect(step({ issueComments: [by("someone-else", "**WAITING-PO:** x")] }).step).toBe(
      "Verify/PR",
    );
    expect(step({ issueComments: [wait(), by("someone-else", "ok go")] }).step).toBe("Waiting PO");
  });

  it("requires a reason after the marker", () => {
    expect(step({ issueComments: [coord("**WAITING-PO:**")] }).step).toBe("Verify/PR");
  });

  it("a running worker stays Work even with the marker", () => {
    expect(step({ worker: { kind: "running" }, issueComments: [wait()] }).step).toBe("Work");
  });

  it("Waiting PO wins over Blocked", () => {
    expect(step({ blockers: [open(1)], issueComments: [wait()] }).step).toBe("Waiting PO");
  });

  it("draws the node the task stands at as blocked, with a sub-label", () => {
    const blocked = diagramNodes("Blocked", cyclePhase([]), {
      at: "Verify/PR",
      sub: "blocked by #158",
    });
    expect(blocked.find((n) => n.id === "Verify/PR")).toMatchObject({
      state: "blocked",
      sub: "blocked by #158",
    });
    expect(blocked.find((n) => n.id === "Work")?.state).toBe("done");
    expect(blocked.find((n) => n.id === "Review")?.state).toBe("todo");
    const po = diagramNodes("Waiting PO", cyclePhase([]), { at: "Start", sub: "waiting PO" });
    expect(po.find((n) => n.id === "Start")).toMatchObject({ state: "blocked", sub: "waiting PO" });
  });

  it("taskLine prints blocked:#N,#M or waiting-po", () => {
    const first = (it_: ProjectItem) => {
      const view = buildTasks({ tasks: read({ items: [it_] }), workers: available([]) });
      if (view.state !== "ok" || !view.items[0]) throw new Error("expected ok");
      return view.items[0];
    };
    const b = first(item({ blockers: [open(158), closed(2), open(160)] }));
    expect(taskLine(b)).toContain(" blocked:#158,#160");
    expect(b.step).toBe("Blocked");
    expect(b.blockers).toEqual([open(158), closed(2), open(160)]);
    const w = first(item({ comments: [wait()] }));
    expect(taskLine(w)).toContain(" waiting-po");
    expect(w.step).toBe("Waiting PO");
    expect(taskLine(first(item()))).not.toMatch(/blocked:|waiting-po/);
  });
});

describe("template diagram (OMI-088)", () => {
  const open = (n: number) => ({ number: n, state: "OPEN" });
  const wait = () => coord("**WAITING-PO:** run the live check");
  const card = async (
    workflow: string | null,
    over: Partial<ProjectItem> = {},
    procs: WorkerProcess[] = [],
    tasks: Partial<Extract<TasksRead, { available: true }>> = {},
  ) => {
    const templates = workflow === null ? {} : { [workflow]: await loadTemplate(workflow) };
    const view = buildTasks({
      tasks: read({
        items: [item({ workflow, ...over })],
        templates,
        prompts: {
          "OMI-074": {
            skills: ["test-driven-development", "verification-before-completion"],
            rules: ["AGENTS.md"],
          },
        },
        ...tasks,
      }),
      workers: available(procs),
    });
    if (view.state !== "ok" || !view.items[0]) throw new Error("expected ok");
    return view.items[0];
  };

  it("draws feature steps and gates from the template, the running worker at implement", async () => {
    const t = await card("feature", {}, [worker]);
    expect(t.flow).toMatchObject({
      source: "template",
      reason: null,
      to: "implement",
      from: "review",
    });
    expect(t.nodes.map((n) => n.id)).toEqual([
      "analyze",
      "scope-approved",
      "implement",
      "verify",
      "review",
      "ready-to-merge",
    ]);
    expect(t.nodes.find((n) => n.id === "implement")?.state).toBe("current");
    expect(t.templateStep).toBe("implement");
    expect(t.role).toBe("developer");
    expect(t.step).toBe("Work");
    expect(t.workflow).toBe("feature");
  });

  it("draws bugfix and docs from their own templates", async () => {
    expect((await card("bugfix", {}, [worker])).nodes.map((n) => n.id)).toContain("reproduce");
    const docs = await card("docs", {}, [worker]);
    expect(docs.nodes.map((n) => n.id)).toEqual([
      "scope-approved",
      "write",
      "verify",
      "accept",
      "docs-acceptance",
      "ready-to-merge",
    ]);
    expect(docs.nodes.find((n) => n.id === "write")?.state).toBe("current");
  });

  it("maps no-worker states: verify (qa), review, ready-to-merge on PASS, Done", async () => {
    const verify = await card("feature");
    expect(verify.templateStep).toBe("verify");
    expect(verify.role).toBe("qa");
    const inReview = { status: "In Review" };
    const review = await card("feature", inReview, [], { pulls: [openPull()] });
    expect(review.templateStep).toBe("review");
    const pass = openPull({ comments: [coord(verdict("PASS"))] });
    const merge = await card("feature", inReview, [], { pulls: [pass] });
    expect(merge.templateStep).toBe("ready-to-merge");
    expect(merge.nodes.find((n) => n.id === "review")?.state).toBe("done");
  });

  it("unknown carries the reason and highlights no step", async () => {
    const t = await card("feature", { status: "In Review" });
    expect(t.step).toBe("unknown");
    expect(t.templateStep).toBe("unknown");
    expect(t.stepReason).toContain("no open PR");
    expect(t.nodes.some((n) => n.state === "current")).toBe(false);
  });

  it("rework goes back to the developer step with rework k/2; Architect joins the path", async () => {
    const two = openPull({ comments: [coord(verdict("FAIL")), coord(verdict("FAIL"))] });
    const t = await card("feature", { status: "In Review" }, [], { pulls: [two] });
    expect(t.rework).toBe(2);
    expect(t.flow.to).toBe("implement");
    expect(t.nodes.map((n) => n.id)).toContain("Architect");
    const one = openPull({ comments: [coord(verdict("FAIL"))] });
    const r = await card("feature", {}, [worker], { pulls: [one] });
    expect(r.nodes.find((n) => n.id === "implement")).toMatchObject({
      state: "current",
      sub: "rework 1/2",
    });
  });

  it("Blocked and Waiting PO mark the node the task stands at", async () => {
    const b = await card("feature", { blockers: [open(158)] });
    expect(b.step).toBe("Blocked");
    expect(b.nodes.find((n) => n.id === "verify")).toMatchObject({
      state: "blocked",
      sub: "blocked by #158",
    });
    const w = await card("feature", { comments: [wait()] });
    expect(w.nodes.find((n) => n.id === "verify")).toMatchObject({
      state: "blocked",
      sub: "waiting PO",
    });
    expect(w.role).toBe("PO");
  });

  it("shows the loaded skills against the template step and marks the mismatch", async () => {
    const t = await card("feature", {}, [worker]);
    expect(t.skillCheck).toEqual({
      expected: ["test-driven-development", "minimal-change"],
      missing: ["minimal-change"],
      extra: [{ name: "verification-before-completion", template: "verify" }],
    });
    expect(t.templateInfo).toMatchObject({ id: "implement", role: "developer" });
    expect(t.skills).toEqual(["test-driven-development", "verification-before-completion"]);
  });

  it("falls back to the lifecycle diagram with the reason when the template cannot be read", async () => {
    const t = await card("nonexistent");
    expect(t.flow).toMatchObject({ source: "lifecycle", from: "Review", to: "Work" });
    expect(t.flow.reason).toContain("nonexistent");
    expect(t.nodes.map((n) => n.id)).toContain("Verify/PR");
    expect(t.skillCheck).toBeNull();
    expect((await card(null)).flow.reason).toContain("Workflow");
    const unread = await card("feature", {}, [], { templates: undefined });
    expect(unread.flow).toMatchObject({ source: "lifecycle", reason: "template not read" });
  });
});
