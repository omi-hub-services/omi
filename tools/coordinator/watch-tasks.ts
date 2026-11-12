// Tasks view of the watch (OMI-074, ADR-0014): Project items In Progress / In Review with the
// lifecycle step derived from what is observable (Project Status, worker processes, the PR and
// the Coordinator's VERDICT / ARCHITECT comments). Everything here is pure except `readPrompts`
// and `readTasks`, which only use the injected runner. Strings from outside are cleaned of
// control characters and rendered by the page through `textContent` / SVG attributes only.
import {
  COORDINATOR_LOGIN,
  PRIORITY_ORDER,
  RUNS_DIR_FROM_HOME,
  type WslTarget,
} from "./coordinator-settings.ts";
import { readProject } from "./github-reads.ts";
import {
  agentReviewOn,
  linkedIssue,
  summarizeChecks,
  type Blocker,
  type OpenPull,
  type ProjectItem,
} from "./github-snapshot.ts";
import type { AuthoredComment } from "./json-shape.ts";
import { wslCommand, type Runner } from "./process-runner.ts";
import { clean, workerTone, type Tone } from "./watch-core.ts";
import {
  compareLoaded,
  loadTemplate,
  mapTemplatePos,
  orderNodes,
  templateNodes,
  workStepId,
  type SkillCheck,
  type TemplatePos,
  type TemplateRead,
} from "./watch-workflow.ts";
import type { WorkerProcess, Workers } from "./wsl-workers.ts";

export type Step =
  | "Start"
  | "Work"
  | "Verify/PR"
  | "Review"
  | "Rework"
  | "Architect"
  | "Merge"
  | "Done"
  | "Blocked"
  | "Waiting PO"
  | "unknown";

export type WorkerLookup =
  | { readonly kind: "running" }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly reason: string };

export interface StepInput {
  readonly status: string | null;
  readonly worker: WorkerLookup;
  readonly pull: {
    readonly headRefOid: string;
    readonly comments: readonly AuthoredComment[];
  } | null;
  /** The worker prompt file exists (the task was dispatched); null when it could not be read. */
  readonly dispatched: boolean | null;
  readonly coordinator?: string;
  /** Blocked-by of the Issue (number and GitHub state). */
  readonly blockers?: readonly Blocker[];
  /** Issue comments, oldest first; the PR comments are newer, so they follow these. */
  readonly issueComments?: readonly AuthoredComment[];
}

export interface StepResult {
  readonly step: Step;
  /** Why the step is `unknown`, `Blocked` or `Waiting PO`, or a warning on `Work`; null otherwise. */
  readonly reason: string | null;
  /** `Blocked` / `Waiting PO` only: the step the task stands at (its last reached step). */
  readonly at?: Step;
}

// ── comment markers (Coordinator account only) ───────────────────────────────

const FAIL = /^\**VERDICT:\**\s*FAIL\b/m;
const ARCHITECT = /^\**ARCHITECT:\**[ \t]+(\S[^\n]*)/m;

const WAITING_PO = /^\**WAITING-PO:\**[ \t]+(\S[^\n]*)/;

/** The reason when the newest Coordinator comment (Issue, then PR, oldest first) is `**WAITING-PO:**`. */
export function detectWaitingPo(
  comments: readonly AuthoredComment[],
  coordinator: string = COORDINATOR_LOGIN,
): string | null {
  const newest = comments.filter((c) => c.author === coordinator).at(-1);
  const reason = newest ? WAITING_PO.exec(newest.body.trimStart())?.[1] : undefined;
  return reason ? clean(reason).slice(0, 200) : null;
}

const own = (comments: readonly AuthoredComment[], coordinator: string) =>
  comments.map((c, index) => ({ index, body: c.author === coordinator ? c.body : "" }));

/** Number of `**VERDICT:** FAIL` comments of the Coordinator account; other accounts are ignored. */
export function countRework(
  comments: readonly AuthoredComment[],
  coordinator: string = COORDINATOR_LOGIN,
): number {
  return own(comments, coordinator).filter((c) => FAIL.test(c.body)).length;
}

/** The newest `**ARCHITECT:** <reason>` comment of the Coordinator account, if any. */
export function detectArchitect(
  comments: readonly AuthoredComment[],
  coordinator: string = COORDINATOR_LOGIN,
): { called: boolean; reason: string | null } {
  for (const c of own(comments, coordinator).reverse()) {
    const reason = ARCHITECT.exec(c.body)?.[1];
    if (reason) return { called: true, reason: clean(reason).slice(0, 200) };
  }
  return { called: false, reason: null };
}

/** The Architect was called after the newest FAIL (comments are oldest first). */
function architectAfterLastFail(comments: readonly AuthoredComment[], coordinator: string) {
  const mine = own(comments, coordinator);
  const last = (marker: RegExp) => mine.filter((c) => marker.test(c.body)).at(-1)?.index ?? -1;
  const lastFail = last(FAIL);
  const lastArchitect = last(ARCHITECT);
  return lastArchitect > lastFail && lastFail >= 0;
}

// ── quality cycle 2 + Architect + 2 ──────────────────────────────────────────

/** Reworks allowed before the Architect, and again after it (design-patterns.md). */
const CYCLE_MAX = 2;

export interface CyclePhase {
  readonly phase: "before-architect" | "architect" | "after-architect" | "escalate-po";
  /** Coordinator FAILs in total. */
  readonly fails: number;
  /** The k of "rework k/2" for the current stage: FAILs before the Architect, or after it. */
  readonly k: number;
  readonly architectCalled: boolean;
}

/**
 * Pure: the phase of the `2 + Architect + 2` cycle from the comments, oldest first. Only the
 * Coordinator account counts. The first `**ARCHITECT:** <reason>` marker is the call; a marker that
 * comes before any FAIL still counts as the call (phase `architect`, lit), and the FAILs after it
 * are the "after Architect" reworks. A FAIL and a marker in one comment: the FAIL comes first.
 */
export function cyclePhase(
  comments: readonly AuthoredComment[],
  coordinator: string = COORDINATOR_LOGIN,
): CyclePhase {
  let fails = 0;
  let failsAfter = 0;
  let called = false;
  for (const c of own(comments, coordinator)) {
    if (FAIL.test(c.body)) {
      fails += 1;
      if (called) failsAfter += 1;
    }
    if (ARCHITECT.test(c.body)) called = true;
  }
  if (!called) {
    return fails >= CYCLE_MAX
      ? { phase: "architect", fails, k: CYCLE_MAX, architectCalled: false }
      : { phase: "before-architect", fails, k: fails, architectCalled: false };
  }
  const phase =
    failsAfter >= CYCLE_MAX ? "escalate-po" : failsAfter === 0 ? "architect" : "after-architect";
  return { phase, fails, k: Math.min(failsAfter, CYCLE_MAX), architectCalled: true };
}

const kOfMax = (k: number) => `${String(k)}/${String(CYCLE_MAX)}`;

/** The card note: what the cycle asks for now; null before any FAIL. */
export function cycleNote(c: CyclePhase): string | null {
  switch (c.phase) {
    case "before-architect":
      return c.fails === 0 ? null : `rework ${kOfMax(c.k)}`;
    case "architect":
      return c.architectCalled
        ? `Architect called, rework ${kOfMax(0)} after Architect`
        : `call the Architect (${String(c.fails)} FAILs, no ARCHITECT marker)`;
    case "after-architect":
      return `rework ${kOfMax(c.k)} (after Architect)`;
    case "escalate-po":
      return `${String(CYCLE_MAX)} FAILs after Architect, ask the PO`;
  }
}

/** One space-free token for the terminal line. */
export function cycleToken(c: CyclePhase): string {
  switch (c.phase) {
    case "before-architect":
      return `rework:${kOfMax(c.k)}`;
    case "architect":
      return c.architectCalled ? "architect:called" : "architect:needed";
    case "after-architect":
      return `after-architect:${kOfMax(c.k)}`;
    case "escalate-po":
      return "ask-po";
  }
}

// ── step derivation ──────────────────────────────────────────────────────────

const result = (step: Step, reason: string | null = null): StepResult => ({ step, reason });

export const openBlockers = (blockers: readonly Blocker[] = []) =>
  blockers.filter((b) => b.state === "OPEN").map((b) => b.number);
const hashList = (numbers: readonly number[]) => numbers.map((n) => `#${String(n)}`).join(", ");

/**
 * Pure: the /omi-next lifecycle step for the observed state, or `unknown` with the reason.
 * `Waiting PO` (a Coordinator marker) and `Blocked` (an open blocker, no worker) replace the step
 * the task stands at, which stays in `at`; a running worker stays `Work` with a warning.
 */
export function deriveStep(input: StepInput): StepResult {
  const stands = lifecycleStep(input);
  if (input.status !== "In Progress" && input.status !== "In Review") return stands;
  const open = openBlockers(input.blockers);
  if (input.worker.kind === "running") {
    return open.length > 0 && stands.reason === null
      ? { ...stands, reason: `worker runs but blocked by ${hashList(open)}` }
      : stands;
  }
  const comments = [...(input.issueComments ?? []), ...(input.pull?.comments ?? [])];
  const waiting = detectWaitingPo(comments, input.coordinator);
  if (waiting !== null) return { step: "Waiting PO", reason: waiting, at: stands.step };
  if (open.length > 0 && input.worker.kind === "none") {
    return { step: "Blocked", reason: `blocked by ${hashList(open)}`, at: stands.step };
  }
  return stands;
}

function lifecycleStep(input: StepInput): StepResult {
  const login = input.coordinator ?? COORDINATOR_LOGIN;
  const { status, worker, pull } = input;
  if (status === "Done") return result("Done");
  if (status !== "In Progress" && status !== "In Review") {
    return result(
      "unknown",
      status === null
        ? "Status is not In Progress or In Review"
        : `Status ${status} is not In Progress or In Review`,
    );
  }
  const comments = pull?.comments ?? [];
  if (worker.kind === "running") {
    return result(countRework(comments, login) > 0 ? "Rework" : "Work");
  }
  if (pull) {
    const onHead = agentReviewOn(comments, pull.headRefOid, login);
    if (onHead?.verdict === "PASS") return result("Merge");
    if (onHead?.verdict === "FAIL") {
      return result(architectAfterLastFail(comments, login) ? "Architect" : "Rework");
    }
    if (onHead) return result("unknown", `VERDICT ${onHead.verdict} is neither PASS nor FAIL`);
  }
  if (worker.kind === "unknown") return result("unknown", `workers unreadable: ${worker.reason}`);
  if (status === "In Review") {
    return pull ? result("Review") : result("unknown", "In Review but no open PR found");
  }
  if (pull) return result("Verify/PR");
  if (input.dispatched === null) {
    return result("unknown", "dispatch state unreadable (worker prompt not read)");
  }
  return result(input.dispatched ? "Verify/PR" : "Start");
}

// ── diagram ──────────────────────────────────────────────────────────────────

export type NodeState = "done" | "current" | "todo" | "lit" | "warn" | "idle" | "blocked";

export interface DiagramNode {
  readonly id: string;
  readonly label: string;
  readonly state: NodeState;
  /** Second line inside the node, e.g. `rework 1/2` on Work. */
  readonly sub?: string;
  /** Template diagram only: a workflow step or gate, and the step's role. */
  readonly kind?: "step" | "gate";
  readonly role?: string;
  /** What the template gives the step; the page shows it when the node is selected. */
  readonly skills?: readonly string[];
  readonly rules?: readonly string[];
}

const MAIN = ["Start", "Work", "Verify/PR", "Review", "Merge", "Done"] as const;

/**
 * Pure: nodes of the lifecycle diagram, main row first. Rework is not a node: it is the edge
 * Review -> Work, drawn by the page when there is a FAIL; while the task is in rework Work is the
 * current node with `rework k/2`. Architect (on the return path) exists from the 2nd FAIL or a
 * marker, Ask PO once the cycle escalates.
 */
export function diagramNodes(
  shown: Step,
  cycle: CyclePhase,
  hold?: { readonly at: Step; readonly sub: string },
): DiagramNode[] {
  // Blocked / Waiting PO: the node the task stands at is drawn `blocked`, the rest as at that step
  const step = hold ? hold.at : shown;
  const rework = step === "Rework";
  // Architect is the step after Review failed: everything up to Review is done
  const lit = step === "Architect" ? "Review" : rework ? "Work" : step;
  const at = (MAIN as readonly string[]).indexOf(lit);
  const main = MAIN.map((id, i): DiagramNode => {
    let state: NodeState = "todo";
    if (at !== -1 && (i < at || (step === "Architect" && i === at))) state = "done";
    else if (at !== -1 && i === at) state = "current";
    if (hold && at !== -1 && i === at) return { id, label: id, state: "blocked", sub: hold.sub };
    return id === "Work" && rework
      ? { id, label: id, state, sub: `rework ${kOfMax(cycle.k)}` }
      : { id, label: id, state };
  });
  return [...main, ...extraNodes(step, cycle)];
}

/** Architect and Ask PO, shared by the lifecycle and the template diagram. */
export function extraNodes(step: Step, cycle: CyclePhase): DiagramNode[] {
  const extra: DiagramNode[] = [];
  if (cycle.phase !== "before-architect") {
    const state: NodeState =
      step === "Architect" ? "current" : cycle.architectCalled ? "lit" : "warn";
    extra.push({ id: "Architect", label: "Architect", state });
  }
  if (cycle.phase === "escalate-po") extra.push({ id: "Ask PO", label: "Ask PO", state: "warn" });
  return extra;
}

// ── prompt parsing ───────────────────────────────────────────────────────────

export interface PromptInfo {
  readonly skills: readonly string[];
  readonly rules: readonly string[];
}

const SKILL_HEADING = /^## Skill:[ \t]+(\S+)/gm;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
const RULE_FILE = /\b(?:AGENTS|CLAUDE)\.md\b|\bdocs\/[A-Za-z0-9_./-]+\.md\b/g;
const MAX_LISTED = 20;

/** Worker restrictions every dispatch prompt carries (omi-next §3); shown beside the rule files. */
export const WORKER_RESTRICTIONS = ["no push, PR or merge", "gh is read-only"] as const;

/**
 * Pure: skills from `## Skill: <name>` headings (OMI-073) and the rule files a prompt mentions
 * (`AGENTS.md`, `CLAUDE.md`, `docs/**.md`). Works on the whole prompt or on the filtered lines the
 * WSL probe prints.
 */
export function parsePromptText(text: string): PromptInfo {
  const skills = [...text.matchAll(SKILL_HEADING)]
    .map((m) => m[1] ?? "")
    .filter((s) => SKILL_NAME.test(s));
  const rules = [...text.matchAll(RULE_FILE)].map((m) => m[0]);
  const uniq = (list: string[]) => [...new Set(list)].slice(0, MAX_LISTED);
  return { skills: uniq(skills), rules: uniq(rules.sort()) };
}

const PLAN_KEY = /^OMI-(\d{1,4})$/;

/** One bash payload: per task, the matching lines of its prompt, never the prompt itself. */
function promptPayload(numbers: readonly string[]): string {
  const grep = `grep -oE '^## Skill: [^ ]+|CLAUDE[.]md|AGENTS[.]md|docs/[A-Za-z0-9_./-]+[.]md'`;
  return (
    `for n in ${numbers.join(" ")}; do f=$HOME/${RUNS_DIR_FROM_HOME}/omi-$n-prompt.md; ` +
    `if [ -f $f ]; then echo @@prompt $n; ${grep} $f; else echo @@missing $n; fi; done`
  );
}

/** Pure: plan key → prompt info, or null when the task has no prompt file. */
export function parsePromptProbe(stdout: string): Record<string, PromptInfo | null> {
  const out: Record<string, PromptInfo | null> = {};
  let key: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (key !== null) out[key] = parsePromptText(lines.join("\n"));
    key = null;
    lines = [];
  };
  for (const line of stdout.split("\n")) {
    const m = /^@@(prompt|missing) (\d{1,4})$/.exec(line.trim());
    if (m?.[1] && m[2]) {
      flush();
      if (m[1] === "missing") out[`OMI-${m[2]}`] = null;
      else key = `OMI-${m[2]}`;
    } else if (key !== null) lines.push(line);
  }
  flush();
  return out;
}

/** Null when the read failed; plan keys that are not `OMI-NNN` are never put in the payload. */
export async function readPrompts(
  run: Runner,
  target: WslTarget,
  planKeys: readonly string[],
): Promise<Record<string, PromptInfo | null> | null> {
  const numbers = [
    ...new Set(
      planKeys.flatMap((k) => (PLAN_KEY.exec(k)?.[1] ? [PLAN_KEY.exec(k)?.[1] ?? ""] : [])),
    ),
  ];
  if (numbers.length === 0) return {};
  try {
    const res = await run(wslCommand(promptPayload(numbers), target, 30_000));
    return res.code === 0 ? parsePromptProbe(res.stdout) : null;
  } catch {
    return null;
  }
}

// ── reading and building ─────────────────────────────────────────────────────

export type TasksRead =
  | {
      readonly available: true;
      readonly items: readonly ProjectItem[];
      readonly pulls: readonly OpenPull[];
      readonly prompts: Readonly<Record<string, PromptInfo | null>>;
      /** Workflow templates by the Issue's Workflow field; absent when none was read. */
      readonly templates?: Readonly<Record<string, TemplateRead>> | undefined;
    }
  | { readonly available: false; readonly reason: string };

const ACTIVE = ["In Progress", "In Review"];
const isActive = (i: ProjectItem) =>
  i.kind === "Issue" &&
  i.state === "OPEN" &&
  i.workType !== "Epic" &&
  ACTIVE.includes(i.status ?? "");

/** Never throws: a failed GitHub read becomes `available: false` with its first line. */
export async function readTasks(
  run: Runner,
  target: WslTarget,
  load: (id: string) => Promise<TemplateRead> = loadTemplate,
): Promise<TasksRead> {
  try {
    const project = await readProject(run);
    const active = project.items.filter(isActive);
    const keys = active.flatMap((i) => (i.planKey ? [i.planKey] : []));
    const prompts = (await readPrompts(run, target, keys)) ?? {};
    const names = [...new Set(active.flatMap((i) => (i.workflow ? [i.workflow] : [])))];
    const templates = Object.fromEntries(
      await Promise.all(names.map(async (n) => [n, await load(n)] as const)),
    );
    return { available: true, items: project.items, pulls: project.pulls, prompts, templates };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { available: false, reason: reason.split("\n")[0] ?? reason };
  }
}

export interface TaskWorker {
  readonly pid: number;
  readonly tool: "claude" | "codex";
  readonly profile: string;
  readonly model: string;
  readonly effort: string;
  readonly elapsedSeconds: number;
  /** null when the worker log could not be read. */
  readonly turns: number | null;
  readonly lastAction: string;
  readonly tone: Tone;
}

export interface TaskPull {
  readonly number: number;
  /** First 7 characters of the head SHA. */
  readonly head: string;
  readonly checks: "pass" | "fail" | "pending" | "none";
  readonly draft: boolean;
}

export interface TaskView {
  readonly planKey: string;
  readonly issue: number | null;
  readonly title: string;
  readonly workflow: string;
  readonly priority: string;
  readonly status: string;
  readonly pr: TaskPull | null;
  readonly step: Step;
  readonly stepReason: string | null;
  /** Blocked-by of the Issue, open and closed; the page lists them. */
  readonly blockers: readonly Blocker[];
  readonly role: string;
  readonly worker: TaskWorker | null;
  /** Coordinator FAILs in total; the page draws the Review -> Work edge when above 0. */
  readonly rework: number;
  readonly cycle: CyclePhase;
  readonly cycleNote: string | null;
  readonly architectReason: string | null;
  readonly skills: readonly string[];
  /** Why there are no skills ("-"); null when some were read. */
  readonly skillsNote: string | null;
  readonly rules: readonly string[];
  readonly nodes: readonly DiagramNode[];
  /** Where the diagram came from and the ends of the rework edge (node ids). */
  readonly flow: {
    readonly source: "template" | "lifecycle";
    /** Why the lifecycle fallback is drawn; null for a template. */
    readonly reason: string | null;
    readonly from: string;
    readonly to: string;
  };
  /** Template step id the task stands at, `Done`, or `unknown`; null in the lifecycle fallback. */
  readonly templateStep: string | null;
  /** The current template step's role, skills and rules; null when it is not a step. */
  readonly templateInfo: {
    readonly id: string;
    readonly role: string;
    readonly skills: readonly string[];
    readonly rules: readonly string[];
  } | null;
  /** Loaded skills against the current template step; null when not comparable. */
  readonly skillCheck: SkillCheck | null;
  readonly ariaLabel: string;
}

export type TasksView =
  | { readonly state: "loading" }
  | { readonly state: "unavailable"; readonly reason: string }
  | { readonly state: "ok"; readonly items: readonly TaskView[] };

export interface TasksInput {
  readonly tasks: TasksRead | null;
  readonly workers: Workers | null;
}

const orDash = (s: string | null | undefined) => clean(s ?? "") || "-";
const rank = (value: string | null) => {
  const i = value === null ? -1 : PRIORITY_ORDER.indexOf(value as (typeof PRIORITY_ORDER)[number]);
  return i === -1 ? PRIORITY_ORDER.length : i;
};

function roleFor(step: Step, projectRole: string | null): string {
  switch (step) {
    case "Work":
    case "Rework":
      return orDash(projectRole);
    case "Review":
      return "Reviewer";
    case "Architect":
      return "Architect";
    case "Start":
    case "Verify/PR":
    case "Merge":
      return "Coordinator";
    case "Waiting PO":
      return "PO";
    default:
      return "-";
  }
}

function taskView(
  item: ProjectItem,
  read: Extract<TasksRead, { available: true }>,
  workers: Workers | null,
): TaskView {
  const planKey = item.planKey;
  const branchPrefix = planKey ? `task/${planKey.toLowerCase()}-` : null;
  const pull =
    read.pulls.find(
      (p) =>
        (item.number !== null && linkedIssue(p.body) === item.number) ||
        (branchPrefix !== null && p.headRefName.toLowerCase().startsWith(branchPrefix)),
    ) ?? null;

  let process: WorkerProcess | null = null;
  let lookup: WorkerLookup;
  if (planKey === null) lookup = { kind: "unknown", reason: "task has no Plan Key" };
  else if (workers === null) lookup = { kind: "unknown", reason: "workers not read yet" };
  else if (!workers.available) {
    lookup = { kind: "unknown", reason: `WSL unavailable: ${orDash(workers.reason)}` };
  } else {
    process = workers.processes.find((p) => p.task === planKey) ?? null;
    lookup = process ? { kind: "running" } : { kind: "none" };
  }

  const prompt = planKey !== null && planKey in read.prompts ? read.prompts[planKey] : undefined;
  const comments = pull?.comments ?? [];
  const derived = deriveStep({
    status: item.status,
    worker: lookup,
    pull,
    dispatched: prompt === undefined ? null : prompt !== null,
    blockers: item.blockers,
    issueComments: item.comments ?? [],
  });
  const open = openBlockers(item.blockers);
  const hold =
    derived.at === undefined
      ? undefined
      : {
          at: derived.at,
          sub:
            derived.step === "Waiting PO"
              ? "waiting PO"
              : `blocked by #${String(open[0])}${open.length > 1 ? ` +${String(open.length - 1)}` : ""}`,
        };
  const cycle = cyclePhase(comments);
  const architect = detectArchitect(comments);
  const label = planKey ?? `#${String(item.number)}`;
  // Rework is not a step of its own: it is Work again, with the rework label
  const shown = derived.step === "Rework" ? "Work" : derived.step;
  const tpl = item.workflow ? read.templates?.[item.workflow] : undefined;
  const workflow = tpl?.ok ? tpl.workflow : null;
  const stands = derived.at ?? derived.step;
  let pos: TemplatePos = { kind: "unknown", reason: "no template" };
  let nodes: DiagramNode[];
  let flow: TaskView["flow"];
  if (workflow) {
    pos =
      stands === "unknown"
        ? { kind: "unknown", reason: derived.reason ?? "step unknown" }
        : mapTemplatePos(workflow, stands);
    const reviewer = mapTemplatePos(workflow, "Review");
    nodes = templateNodes(
      workflow,
      pos,
      cycle,
      hold?.sub,
      stands === "Rework" ? `rework ${kOfMax(cycle.k)}` : undefined,
      stands === "Architect",
    );
    flow = {
      source: "template",
      reason: null,
      from: reviewer.kind === "node" ? reviewer.id : (orderNodes(workflow).at(-1)?.id ?? ""),
      to: workStepId(workflow),
    };
  } else {
    nodes = diagramNodes(derived.step, cycle, hold);
    const why =
      tpl && !tpl.ok ? tpl.reason : item.workflow ? "template not read" : "Workflow field is empty";
    flow = { source: "lifecycle", reason: clean(why), from: "Review", to: "Work" };
  }
  const current = workflow && pos.kind === "node" ? pos.id : null;
  const info = workflow ? orderNodes(workflow).find((n) => n.id === current) : undefined;
  const templateInfo =
    info?.kind === "step" && info.role !== undefined
      ? { id: info.id, role: info.role, skills: info.skills, rules: info.rules }
      : null;
  // The template role applies to the steps a worker or the Coordinator runs, not to holds
  const roleStep = ["Work", "Rework", "Verify/PR", "Review"].includes(derived.step);
  const stepReason = derived.reason ?? (pos.kind === "unknown" && workflow ? pos.reason : null);
  const skillsNote =
    prompt === undefined
      ? "no prompt read (WSL unavailable or task has no Plan Key)"
      : prompt === null
        ? `no prompt file in ~/${RUNS_DIR_FROM_HOME}`
        : prompt.skills.length === 0
          ? "prompt has no ## Skill: headings"
          : null;

  return {
    planKey: orDash(planKey),
    issue: item.number,
    title: orDash(item.title),
    workflow: orDash(item.workflow),
    priority: orDash(item.priority),
    status: orDash(item.status),
    pr: pull && {
      number: pull.number,
      head: pull.headRefOid.slice(0, 7),
      checks: summarizeChecks(pull.checks, []).overall,
      draft: pull.isDraft,
    },
    step: shown,
    stepReason: stepReason === null ? null : clean(stepReason),
    blockers: item.blockers.map((b) => ({ number: b.number, state: clean(b.state) })),
    role: roleStep && templateInfo ? clean(templateInfo.role) : roleFor(derived.step, item.role),
    worker: process && {
      pid: process.pid,
      tool: process.tool,
      profile: orDash(process.profile),
      model: orDash(process.model),
      effort: orDash(process.effort),
      elapsedSeconds: Math.max(0, Math.floor(process.elapsedSeconds)),
      turns: process.log ? process.log.numTurns : null,
      lastAction: orDash(process.log?.lastAction),
      tone: workerTone(process.log),
    },
    rework: cycle.fails,
    cycle,
    cycleNote: cycleNote(cycle),
    architectReason: architect.reason,
    skills: prompt?.skills ?? [],
    skillsNote,
    rules: prompt ? [...prompt.rules, ...WORKER_RESTRICTIONS] : [],
    nodes,
    flow,
    templateStep: !workflow
      ? null
      : pos.kind === "node"
        ? pos.id
        : pos.kind === "done"
          ? "Done"
          : pos.kind === "before"
            ? "Start"
            : "unknown",
    templateInfo,
    skillCheck:
      workflow && current && prompt ? compareLoaded(workflow, current, prompt.skills) : null,
    ariaLabel:
      `${orDash(label)}: Workflow: ${orDash(item.workflow)}, current step ${shown}` +
      (workflow && current ? ` (${current})` : "") +
      (derived.step === "Rework" ? `, rework ${kOfMax(cycle.k)}` : "") +
      (derived.reason === null ? "" : ` (${clean(derived.reason)})`),
  };
}

/** Pure: the Tasks section of the snapshot. */
export function buildTasks(input: TasksInput): TasksView {
  const { tasks, workers } = input;
  if (!tasks) return { state: "loading" };
  if (!tasks.available) return { state: "unavailable", reason: orDash(tasks.reason) };
  const items = tasks.items
    .filter(isActive)
    .sort(
      (a, b) =>
        ACTIVE.indexOf(a.status ?? "") - ACTIVE.indexOf(b.status ?? "") ||
        rank(a.priority) - rank(b.priority) ||
        (a.number ?? 0) - (b.number ?? 0),
    )
    .map((item) => taskView(item, tasks, workers));
  return { state: "ok", items };
}

/** One line per task for the terminal watch: `OMI-NNN workflow step phase role tool/profile`. */
export function taskLine(t: TaskView): string {
  const who = t.worker ? `${t.worker.tool}/${t.worker.profile}` : "-/-";
  const hold =
    t.step === "Blocked"
      ? ` blocked:${openBlockers(t.blockers)
          .map((n) => `#${String(n)}`)
          .join(",")}`
      : t.step === "Waiting PO"
        ? " waiting-po"
        : "";
  const step = t.step.replace(" ", "-"); // one token per column
  return `${t.planKey} ${t.workflow} ${step} ${cycleToken(t.cycle)} ${t.role} ${who}${hold}`;
}
