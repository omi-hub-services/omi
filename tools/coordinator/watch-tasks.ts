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
  type OpenPull,
  type ProjectItem,
} from "./github-snapshot.ts";
import type { AuthoredComment } from "./json-shape.ts";
import { wslCommand, type Runner } from "./process-runner.ts";
import { clean, workerTone, type Tone } from "./watch-core.ts";
import type { WorkerProcess, Workers } from "./wsl-workers.ts";

export type Step =
  "Start" | "Work" | "Verify/PR" | "Review" | "Rework" | "Architect" | "Merge" | "Done" | "unknown";

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
}

export interface StepResult {
  readonly step: Step;
  /** Why the step is `unknown`; null otherwise. */
  readonly reason: string | null;
}

// ── comment markers (Coordinator account only) ───────────────────────────────

const FAIL = /^\**VERDICT:\**\s*FAIL\b/m;
const ARCHITECT = /^\**ARCHITECT:\**[ \t]+(\S[^\n]*)/m;

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

// ── step derivation ──────────────────────────────────────────────────────────

const result = (step: Step, reason: string | null = null): StepResult => ({ step, reason });

/** Pure: the /omi-next lifecycle step for the observed state, or `unknown` with the reason. */
export function deriveStep(input: StepInput): StepResult {
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

export type NodeState = "done" | "current" | "todo" | "lit" | "warn" | "idle";

export interface DiagramNode {
  readonly id: string;
  readonly label: string;
  readonly state: NodeState;
}

const MAIN = ["Start", "Work", "Verify/PR", "Review", "Merge", "Done"] as const;
/** Fail count at which the quality cycle `2 + Architect + 2` calls for the Architect. */
const ARCHITECT_AT = 2;

export const architectState = (rework: number, called: boolean) =>
  called ? "called" : rework >= ARCHITECT_AT ? "warn" : "none";

/** Pure: node states of the lifecycle diagram, main row first, then the Rework loop and Architect. */
export function diagramNodes(step: Step, rework: number, architectCalled: boolean): DiagramNode[] {
  const onLoop = step === "Rework" || step === "Architect";
  const at = onLoop ? MAIN.indexOf("Review") : MAIN.indexOf(step as (typeof MAIN)[number]);
  const main = MAIN.map((id, i): DiagramNode => {
    const state: NodeState =
      at === -1
        ? "todo"
        : onLoop
          ? i <= at
            ? "done"
            : "todo"
          : i < at
            ? "done"
            : i === at
              ? "current"
              : "todo";
    return { id, label: id, state };
  });
  const architect = architectState(rework, architectCalled);
  return [
    ...main,
    {
      id: "Rework",
      label: "Rework",
      state: step === "Rework" ? "current" : rework > 0 ? "done" : "todo",
    },
    {
      id: "Architect",
      label: "Architect",
      state:
        step === "Architect"
          ? "current"
          : architect === "called"
            ? "lit"
            : architect === "warn"
              ? "warn"
              : "idle",
    },
  ];
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
    }
  | { readonly available: false; readonly reason: string };

const ACTIVE = ["In Progress", "In Review"];
const isActive = (i: ProjectItem) =>
  i.kind === "Issue" &&
  i.state === "OPEN" &&
  i.workType !== "Epic" &&
  ACTIVE.includes(i.status ?? "");

/** Never throws: a failed GitHub read becomes `available: false` with its first line. */
export async function readTasks(run: Runner, target: WslTarget): Promise<TasksRead> {
  try {
    const project = await readProject(run);
    const keys = project.items.filter(isActive).flatMap((i) => (i.planKey ? [i.planKey] : []));
    const prompts = (await readPrompts(run, target, keys)) ?? {};
    return { available: true, items: project.items, pulls: project.pulls, prompts };
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
  readonly role: string;
  readonly worker: TaskWorker | null;
  readonly rework: number;
  readonly architect: "called" | "warn" | "none";
  readonly architectReason: string | null;
  readonly skills: readonly string[];
  /** Why there are no skills ("-"); null when some were read. */
  readonly skillsNote: string | null;
  readonly rules: readonly string[];
  readonly nodes: readonly DiagramNode[];
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
  });
  const rework = countRework(comments);
  const architect = detectArchitect(comments);
  const label = planKey ?? `#${String(item.number)}`;
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
    step: derived.step,
    stepReason: derived.reason === null ? null : clean(derived.reason),
    role: roleFor(derived.step, item.role),
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
    rework,
    architect: architectState(rework, architect.called),
    architectReason: architect.reason,
    skills: prompt?.skills ?? [],
    skillsNote,
    rules: prompt ? [...prompt.rules, ...WORKER_RESTRICTIONS] : [],
    nodes: diagramNodes(derived.step, rework, architect.called),
    ariaLabel:
      `${orDash(label)}: current step ${derived.step}` +
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

/** One line per task for the terminal watch: `OMI-NNN step role tool/profile rework:N`. */
export function taskLine(t: TaskView): string {
  const who = t.worker ? `${t.worker.tool}/${t.worker.profile}` : "-/-";
  return `${t.planKey} ${t.step} ${t.role} ${who} rework:${String(t.rework)}`;
}
