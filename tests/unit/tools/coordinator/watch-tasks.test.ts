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

describe("parsePromptText", () => {
  const prompt = [
    "# Workflow feature · step implement · role developer",
    "",
    "# Step implement (developer)",
    "Read `AGENTS.md` and docs/architecture/architecture.md.",
    "## Skill: test-driven-development (follow it; report it under Skills applied)",
    "body mentioning ## Skill: not-a-heading",
    "## Skill: minimal-change (follow it)",
    "## Skill: ../../evil\u001b[2J",
    "## Rule: project-baseline (mandatory)",
    "## Rule: evidence-and-tests (applies to this step)",
    "## Rule: ../bad (mandatory)",
    "# Workflow bugfix · step verify · role qa",
  ].join("\n");

  it("reads skills, rules, which rules are mandatory and the worker's own step header", () => {
    expect(parsePromptText(prompt)).toEqual({
      skills: ["test-driven-development", "minimal-change"],
      rules: ["project-baseline", "evidence-and-tests"],
      mandatoryRules: ["project-baseline"],
      header: { workflow: "feature", step: "implement", role: "developer" },
    });
  });

  it("returns empty lists and no header for a prompt with none", () => {
    expect(parsePromptText("hello")).toEqual({
      skills: [],
      rules: [],
      mandatoryRules: [],
      header: null,
    });
  });

  it("takes the header only from a line that starts with it, with plain ids", () => {
    const quoted = "- the header `# Workflow <id> · step <step> · role <role>` names the step";
    expect(parsePromptText(quoted).header).toBeNull();
    expect(parsePromptText("# Workflow <id> · step <step> · role <role>").header).toBeNull();
    expect(parsePromptText("# Workflow feature · step ../x · role developer").header).toBeNull();
    const resumed = "# Native resume\n\n# Workflow feature · step review · role reviewer\n";
    expect(parsePromptText(resumed).header).toEqual({
      workflow: "feature",
      step: "review",
      role: "reviewer",
    });
  });

  it("does not let a header-like line further down override the first one", () => {
    const text = [
      "# Workflow feature · step review · role reviewer",
      "# Workflow feature · step implement · role developer",
    ];
    expect(parsePromptText(text.join("\n")).header?.step).toBe("review");
  });
});

describe("parsePromptProbe / readPrompts", () => {
  it("maps each requested task to its prompt info, null for a missing file", () => {
    const out = [
      "@@prompt 074",
      "# Workflow feature · step verify · role qa",
      "## Skill: minimal-change (follow it)",
      "## Rule: project-baseline (mandatory)",
      "@@missing 073",
      "@@prompt 075",
    ].join("\n");
    expect(parsePromptProbe(out)).toEqual({
      "OMI-074": {
        skills: ["minimal-change"],
        rules: ["project-baseline"],
        mandatoryRules: ["project-baseline"],
        header: { workflow: "feature", step: "verify", role: "qa" },
      },
      "OMI-073": null,
      "OMI-075": { skills: [], rules: [], mandatoryRules: [], header: null },
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
    expect(payload).toContain("# Workflow ");
    expect(payload).toContain("## Rule: ");
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
  prompts: {
    "OMI-074": {
      skills: ["minimal-change"],
      rules: ["AGENTS.md"],
      mandatoryRules: [],
      header: null,
    },
  },
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
    expect(t?.rules).toEqual(["AGENTS.md"]);
    expect(t?.template).toBeNull(); // no template named "Development"
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
    expect(view.items[0]?.prompt).toBeNull();
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

describe("template position, worker step and hold of a task view", () => {
  const open = (n: number) => ({ number: n, state: "OPEN" });
  const wait = () => coord("**WAITING-PO:** run the live check");
  const header = (step: string, role: string, workflow = "feature") => ({
    skills: ["minimal-change"],
    rules: ["project-baseline"],
    mandatoryRules: ["project-baseline"],
    header: { workflow, step, role },
  });
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
        prompts: { "OMI-074": header("implement", "developer") },
        ...tasks,
      }),
      workers: available(procs),
    });
    if (view.state !== "ok" || !view.items[0]) throw new Error("expected ok");
    return view.items[0];
  };

  it("keeps the feature template and puts the running worker at implement when its header says so", async () => {
    const t = await card("feature", {}, [worker]);
    expect(t.template?.id).toBe("feature");
    expect(t.pos).toEqual({ kind: "node", id: "implement" });
    expect(t.workerStep).toEqual({ step: "implement", role: "developer" });
    expect(t.role).toBe("developer");
    expect(t.step).toBe("Work");
  });

  it("takes the step of a running worker from its prompt header, not from the lifecycle", async () => {
    const qa = await card("feature", {}, [worker], {
      prompts: { "OMI-074": header("verify", "qa") },
    });
    expect(qa.pos).toEqual({ kind: "node", id: "verify" });
    expect(qa.workerStep).toEqual({ step: "verify", role: "qa" });
    expect(qa.role).toBe("qa");
    const reviewer = await card("feature", { status: "In Review" }, [worker], {
      prompts: { "OMI-074": header("review", "reviewer") },
      pulls: [openPull()],
    });
    expect(reviewer.pos).toEqual({ kind: "node", id: "review" });
    expect(reviewer.role).toBe("reviewer");
  });

  it("does not guess the step of a running worker whose prompt has no header", async () => {
    const t = await card("feature", {}, [worker], {
      prompts: { "OMI-074": { skills: [], rules: [], mandatoryRules: [], header: null } },
    });
    expect(t.workerStep).toBeNull();
    expect(t.pos).toEqual({ kind: "node", id: "implement" }); // the lifecycle's own position
  });

  it("ignores a header for another workflow or a step the template does not have", async () => {
    const other = await card("feature", {}, [worker], {
      prompts: { "OMI-074": header("verify", "qa", "ui-ux") },
    });
    expect(other.workerStep).toBeNull();
    const unknownStep = await card("feature", {}, [worker], {
      prompts: { "OMI-074": header("deploy", "devops") },
    });
    expect(unknownStep.workerStep).toBeNull();
    const gate = await card("feature", {}, [worker], {
      prompts: { "OMI-074": header("ready-to-merge", "qa") },
    });
    expect(gate.workerStep).toBeNull();
  });

  it("ignores the header when no worker runs, because the prompt file may be an old step's", async () => {
    const t = await card("feature", {}, [], {
      prompts: { "OMI-074": header("review", "reviewer") },
    });
    expect(t.workerStep).toBeNull();
    expect(t.pos).toEqual({ kind: "node", id: "verify" });
    expect(t.role).toBe("qa");
  });

  it("maps no-worker states: verify (qa), review, ready-to-merge on PASS", async () => {
    const verify = await card("feature");
    expect(verify.pos).toEqual({ kind: "node", id: "verify" });
    const inReview = { status: "In Review" };
    const review = await card("feature", inReview, [], { pulls: [openPull()] });
    expect(review.pos).toEqual({ kind: "node", id: "review" });
    const pass = openPull({ comments: [coord(verdict("PASS"))] });
    const merge = await card("feature", inReview, [], { pulls: [pass] });
    expect(merge.pos).toEqual({ kind: "node", id: "ready-to-merge" });
  });

  it("is unknown, with the reason, when the observed state does not say where the task stands", async () => {
    const t = await card("feature", { status: "In Review" });
    expect(t.step).toBe("unknown");
    expect(t.pos.kind).toBe("unknown");
    expect(t.stepReason).toContain("no open PR");
  });

  it("counts rework and reaches the Architect from the Coordinator's FAIL comments", async () => {
    const two = openPull({ comments: [coord(verdict("FAIL")), coord(verdict("FAIL"))] });
    const t = await card("feature", { status: "In Review" }, [], { pulls: [two] });
    expect(t.rework).toBe(2);
    expect(t.cycle.phase).toBe("architect");
    const one = openPull({ comments: [coord(verdict("FAIL"))] });
    const r = await card("feature", {}, [worker], { pulls: [one] });
    expect(r.rework).toBe(1);
    expect(r.step).toBe("Work"); // rework is Work again, with the count beside it
  });

  it("Blocked and Waiting PO keep the node the task stands at and carry the hold", async () => {
    const b = await card("feature", { blockers: [open(158)] });
    expect(b.step).toBe("Blocked");
    expect(b.pos).toEqual({ kind: "node", id: "verify" });
    expect(b.hold).toEqual({ kind: "blocked", by: [158] });
    const w = await card("feature", { comments: [wait()] });
    expect(w.pos).toEqual({ kind: "node", id: "verify" });
    expect(w.hold).toEqual({ kind: "waiting-po" });
    expect(w.role).toBe("PO");
    expect((await card("feature")).hold).toBeNull();
  });

  it("carries the loaded skills, rules and the prompt for the snapshot", async () => {
    const t = await card("feature", {}, [worker]);
    expect(t.skills).toEqual(["minimal-change"]);
    expect(t.rules).toEqual(["project-baseline"]);
    expect(t.prompt?.mandatoryRules).toEqual(["project-baseline"]);
  });

  it("has no template, and says why, when the Workflow cannot be read", async () => {
    const t = await card("nonexistent");
    expect(t.template).toBeNull();
    expect(t.pos.kind).toBe("unknown");
    expect(t.templateReason).toContain("nonexistent");
    expect((await card(null)).templateReason).toContain("Workflow");
    const unread = await card("feature", {}, [], { templates: undefined });
    expect(unread.templateReason).toBe("template not read");
    expect(unread.template).toBeNull();
  });
});
