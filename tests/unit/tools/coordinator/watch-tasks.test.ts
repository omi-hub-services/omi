import { describe, expect, it } from "vitest";
import { COORDINATOR_LOGIN } from "../../../../tools/coordinator/coordinator-settings.ts";
import type { OpenPull, ProjectItem } from "../../../../tools/coordinator/github-snapshot.ts";
import type { Command } from "../../../../tools/coordinator/process-runner.ts";
import {
  buildTasks,
  countRework,
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

describe("diagramNodes", () => {
  const states = (s: Parameters<typeof diagramNodes>[0], rework = 0, called = false) =>
    Object.fromEntries(diagramNodes(s, rework, called).map((n) => [n.id, n.state]));

  it("has a text label for every node, in lifecycle order", () => {
    const nodes = diagramNodes("Start", 0, false);
    expect(nodes.map((n) => n.id)).toEqual([
      "Start",
      "Work",
      "Verify/PR",
      "Review",
      "Merge",
      "Done",
      "Rework",
      "Architect",
    ]);
    expect(nodes.every((n) => n.label.length > 0)).toBe(true);
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

  it("lights the loop and Architect nodes", () => {
    expect(states("Rework", 1)).toMatchObject({ Review: "done", Rework: "current", Merge: "todo" });
    expect(states("Review", 1).Rework).toBe("done");
    expect(states("Review", 0).Rework).toBe("todo");
    expect(states("Architect", 2, true)).toMatchObject({ Architect: "current", Rework: "done" });
    expect(states("Review", 2, true).Architect).toBe("lit");
    expect(states("Review", 1, false).Architect).toBe("idle");
  });

  it("warns at two FAILs without the Architect, never once it was called", () => {
    expect(states("Review", 2, false).Architect).toBe("warn");
    expect(states("Rework", 3, false).Architect).toBe("warn");
    expect(states("Rework", 2, true).Architect).toBe("lit");
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
      architect: "none",
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
    expect(t?.ariaLabel).toBe("OMI-074: current step Work");
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
      architect: "called",
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
    expect(view.items[0]).toMatchObject({ step: "Review", role: "Reviewer", architect: "warn" });
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
  it("prints OMI-NNN step role tool/profile rework:N on one line", () => {
    const view = buildTasks({ tasks: read(), workers: available([worker]) });
    if (view.state !== "ok" || !view.items[0]) throw new Error("expected ok");
    expect(taskLine(view.items[0])).toBe("OMI-074 Work Developer claude/minibox rework:0");
    expect(taskLine({ ...view.items[0], worker: null, step: "Review", role: "Reviewer" })).toBe(
      "OMI-074 Review Reviewer -/- rework:0",
    );
  });
});
