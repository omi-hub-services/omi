// OMI-006 — I/O side of the live GitHub probe: runs `gh` (execFile, no shell), records every call
// as an evidence step and persists the shared state file between the phases that different
// GitHub actors run. Test-only code; see probe-model.ts.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import {
  assertSandboxCall,
  assertSandboxTarget,
  type CallOutcome,
  type CapabilityId,
  classifyOutcome,
  type Evidence,
  formatCall,
  graphqlErrorMessages,
  httpStatusOf,
  type Phase,
  type PhaseRun,
  redact,
  type SandboxTarget,
  type StepRecord,
  type StepResult,
  type Verdict,
} from "./probe-model.ts";

export type FieldKey = "select" | "text" | "number" | "date";
export type IssueKey = "parent" | "childA" | "childB" | "dev";
export type PrKey = "approve" | "check" | "dev";
export type RunKey = "reviewerGate" | "selfReview";

export interface IssueRef {
  readonly number: number;
  readonly id: number;
  readonly nodeId: string;
  readonly url: string;
}
export interface PrRef {
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly base: string;
}
export interface FieldRef {
  readonly id: string;
  readonly name: string;
  readonly optionId: string | null;
}
export interface RunRef {
  readonly id: number;
  readonly triggeredBy: string;
}

/** Shared between phases (and machines); holds IDs only, never tokens. */
export interface ProbeState {
  readonly schemaVersion: 1;
  readonly task: "OMI-006";
  readonly runId: string;
  readonly repo: string;
  readonly projectOwner: string;
  readonly projectNumber: number;
  readonly approver: string;
  author: string | null;
  approverId: number | null;
  defaultBranch: string | null;
  projectId: string | null;
  fields: Partial<Record<FieldKey, FieldRef>>;
  statusField: FieldRef | null;
  createdFieldIds: string[];
  itemIds: string[];
  issues: Partial<Record<IssueKey, IssueRef>>;
  branches: string[];
  prs: Partial<Record<PrKey, PrRef>>;
  rulesetId: number | null;
  readonly environmentName: string;
  environmentId: number | null;
  readonly workflowFile: string;
  workflowCommitted: boolean;
  runs: Partial<Record<RunKey, RunRef>>;
  cleanedUpAt: string | null;
}

export function newState(target: SandboxTarget, approver: string, runId: string): ProbeState {
  return {
    schemaVersion: 1,
    task: "OMI-006",
    runId,
    repo: target.repo,
    projectOwner: target.projectOwner,
    projectNumber: target.projectNumber,
    approver,
    author: null,
    approverId: null,
    defaultBranch: null,
    projectId: null,
    fields: {},
    statusField: null,
    createdFieldIds: [],
    itemIds: [],
    issues: {},
    branches: [],
    prs: {},
    rulesetId: null,
    environmentName: "omi-probe-gate",
    environmentId: null,
    workflowFile: "omi-probe.yml",
    workflowCommitted: false,
    runs: {},
    cleanedUpAt: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the state file at the boundary and re-applies the production guard. */
export function loadState(path: string): ProbeState {
  if (!existsSync(path)) throw new Error(`state file not found: ${path} (run setup first)`);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || parsed["task"] !== "OMI-006" || parsed["schemaVersion"] !== 1) {
    throw new Error(`${path} is not an OMI-006 probe state file`);
  }
  const { repo, projectOwner, projectNumber, approver, runId } = parsed;
  if (
    typeof repo !== "string" ||
    typeof projectOwner !== "string" ||
    typeof projectNumber !== "number" ||
    typeof approver !== "string" ||
    typeof runId !== "string"
  ) {
    throw new Error(`${path}: repo, projectOwner, projectNumber, approver and runId are required`);
  }
  assertSandboxTarget({ repo, projectOwner, projectNumber });
  for (const key of ["fields", "issues", "prs", "runs"] as const) {
    if (!isRecord(parsed[key])) throw new Error(`${path}: ${key} must be an object`);
  }
  for (const key of ["createdFieldIds", "itemIds", "branches"] as const) {
    if (!Array.isArray(parsed[key])) throw new Error(`${path}: ${key} must be an array`);
  }
  return parsed as unknown as ProbeState;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadOrCreateEvidence(path: string, state: ProbeState): Evidence {
  if (!existsSync(path)) {
    return {
      task: "OMI-006",
      schemaVersion: 1,
      repo: state.repo,
      projectOwner: state.projectOwner,
      projectNumber: state.projectNumber,
      runId: state.runId,
      phases: [],
      steps: [],
    };
  }
  const evidence = readEvidence(path);
  if (evidence.runId !== state.runId || evidence.repo !== state.repo) {
    throw new Error(
      `${path} belongs to run ${evidence.runId} on ${evidence.repo}; use a new evidence file`,
    );
  }
  return evidence;
}

export function readEvidence(path: string): Evidence {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(parsed) ||
    parsed["task"] !== "OMI-006" ||
    !Array.isArray(parsed["steps"]) ||
    !Array.isArray(parsed["phases"])
  ) {
    throw new Error(`${path} is not an OMI-006 evidence file`);
  }
  return parsed as unknown as Evidence;
}

/** Runs gh without a shell, in a temp cwd so no local git checkout (e.g. this repo) is picked up. */
export function runGh(
  args: readonly string[],
  input: string | undefined,
  timeoutMs: number,
): Promise<CallOutcome> {
  return new Promise((resolve) => {
    const child = execFile(
      "gh",
      [...args],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr, timedOut: false });
          return;
        }
        const timedOut = error.killed === true && error.signal === "SIGTERM";
        const code =
          typeof error.code === "number" ? error.code : error.code === "ENOENT" ? 127 : 1;
        resolve({
          code: timedOut ? 124 : code,
          stdout,
          stderr: stderr === "" ? error.message : stderr,
          timedOut,
        });
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}

export type Observed = Record<string, string | number | boolean | null>;

export interface StepSpec {
  readonly id: string;
  readonly capability: CapabilityId;
  readonly api: string;
  readonly args: readonly string[];
  /** Serialised to JSON and sent on stdin (`gh api … --input -`). */
  readonly body?: unknown;
  readonly expect: "success" | "denied";
  readonly verify?: (stdout: string) => Verdict;
  readonly observe?: (stdout: string) => Observed;
  /** Cleanup: a 404 means "already gone" and counts as supported. */
  readonly allowNotFound?: boolean;
  /** Exit codes that still carry a valid answer (`gh pr checks`: 1 = failing, 8 = pending). */
  readonly okExitCodes?: readonly number[];
  readonly timeoutMs?: number;
}

export interface StepOutcome {
  /** gh exited 0 and returned no GraphQL errors. */
  readonly ok: boolean;
  readonly stdout: string;
  readonly record: StepRecord;
}

export interface ObservationSpec {
  readonly id: string;
  readonly capability: CapabilityId;
  readonly api: string;
  readonly command: string;
  readonly result: StepResult;
  readonly detail: string;
  readonly observed?: Observed;
}

export class ProbeSession {
  readonly target: SandboxTarget;
  readonly state: ProbeState;
  readonly phase: Phase;
  readonly waitSeconds: number;
  actor = "unknown";
  private readonly statePath: string;
  private readonly evidence: Evidence;
  private readonly evidencePath: string;
  private run: PhaseRun | undefined;

  constructor(options: {
    state: ProbeState;
    statePath: string;
    evidence: Evidence;
    evidencePath: string;
    phase: Phase;
    waitSeconds: number;
  }) {
    this.state = options.state;
    this.target = {
      repo: options.state.repo,
      projectOwner: options.state.projectOwner,
      projectNumber: options.state.projectNumber,
    };
    this.statePath = options.statePath;
    this.evidence = options.evidence;
    this.evidencePath = options.evidencePath;
    this.phase = options.phase;
    this.waitSeconds = options.waitSeconds;
  }

  get repo(): string {
    return this.state.repo;
  }

  /** Raw gh call with the sandbox guard; not recorded (used for polling reads). */
  gh(args: readonly string[], body?: unknown, timeoutMs = 120_000): Promise<CallOutcome> {
    const input = body === undefined ? undefined : JSON.stringify(body);
    assertSandboxCall(args, input, this.target);
    return runGh(args, input, timeoutMs);
  }

  startPhase(actor: string, environment: Record<string, string | null>): void {
    this.actor = actor;
    this.run = { phase: this.phase, actor, startedAt: new Date().toISOString(), environment };
    this.evidence.phases.push(this.run);
    this.flush();
  }

  finishPhase(aborted?: string): void {
    if (this.run !== undefined) {
      this.run.finishedAt = new Date().toISOString();
      if (aborted !== undefined) this.run.aborted = redact(aborted);
    }
    this.flush();
  }

  async step(spec: StepSpec): Promise<StepOutcome> {
    const input = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    const started = performance.now();
    assertSandboxCall(spec.args, input, this.target);
    const raw = await runGh(spec.args, input, spec.timeoutMs ?? 120_000);
    const outcome =
      spec.okExitCodes?.includes(raw.code) === true && raw.stdout.trim() !== ""
        ? { ...raw, code: 0 }
        : raw;
    const durationMs = Math.round(performance.now() - started);
    const ok = outcome.code === 0 && graphqlErrorMessages(outcome.stdout).length === 0;
    const status = httpStatusOf(outcome.stderr);
    let verdict = classifyOutcome(spec.expect, outcome, spec.verify);
    if (spec.allowNotFound === true && !ok && status === 404) {
      verdict = { result: "supported", note: "already gone (HTTP 404)" };
    }
    let observed: Observed = {};
    if (ok && spec.observe !== undefined) {
      try {
        observed = spec.observe(outcome.stdout);
      } catch (error) {
        observed = { observeError: errorMessage(error) };
      }
    }
    const record: StepRecord = {
      id: spec.id,
      capability: spec.capability,
      phase: this.phase,
      actor: this.actor,
      api: spec.api,
      command: formatCall(spec.args, input),
      expect: spec.expect,
      result: verdict.result,
      httpStatus: status,
      exitCode: raw.code,
      detail: redact(verdict.note),
      observed: redactObserved(observed),
      at: new Date().toISOString(),
      durationMs,
    };
    this.push(record);
    return { ok, stdout: outcome.stdout, record };
  }

  /** Records a fact derived from earlier reads (no gh call of its own). */
  observe(spec: ObservationSpec): StepRecord {
    const record: StepRecord = {
      id: spec.id,
      capability: spec.capability,
      phase: this.phase,
      actor: this.actor,
      api: spec.api,
      command: redact(spec.command),
      expect: "observe",
      result: spec.result,
      httpStatus: null,
      exitCode: null,
      detail: redact(spec.detail),
      observed: redactObserved(spec.observed ?? {}),
      at: new Date().toISOString(),
      durationMs: 0,
    };
    this.push(record);
    return record;
  }

  /** A step that could not run because a prerequisite failed. */
  skip(id: string, capability: CapabilityId, api: string, reason: string): void {
    this.observe({
      id,
      capability,
      api,
      command: "(not run)",
      result: "error",
      detail: `skipped: ${reason}`,
    });
  }

  saveState(): void {
    writeJson(this.statePath, this.state);
  }

  /** Polls `read` every `intervalMs` until it returns a value or `waitSeconds` pass. */
  async poll<T>(
    read: () => Promise<T | undefined>,
    intervalMs = 5_000,
    seconds = this.waitSeconds,
  ): Promise<T | undefined> {
    const deadline = performance.now() + seconds * 1000;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (performance.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private push(record: StepRecord): void {
    this.evidence.steps.push(record);
    const mark = record.result === "supported" ? "ok " : record.result.padEnd(3).slice(0, 3);
    console.log(
      `[${mark}] ${record.id} — ${record.result}${record.detail ? `: ${record.detail.slice(0, 160)}` : ""}`,
    );
    this.flush();
  }

  private flush(): void {
    writeJson(this.evidencePath, this.evidence);
  }
}

function redactObserved(observed: Observed): Observed {
  const out: Observed = {};
  for (const [key, value] of Object.entries(observed)) {
    out[key] = typeof value === "string" ? redact(value) : value;
  }
  return out;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parses JSON stdout; returns undefined when it is not JSON. */
export function parseJsonOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
}

/** Reads a nested value by a dotted path (`a.b.0.c`); undefined when any step is missing. */
export function pick(value: unknown, path: string): unknown {
  if (path === "") return value;
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
    else if (isRecord(current)) current = current[key];
    else return undefined;
  }
  return current;
}

export function pickString(value: unknown, path: string): string | undefined {
  const found = pick(value, path);
  return typeof found === "string" ? found : undefined;
}

export function pickNumber(value: unknown, path: string): number | undefined {
  const found = pick(value, path);
  return typeof found === "number" ? found : undefined;
}

export function pickArray(value: unknown, path: string): unknown[] {
  const found = pick(value, path);
  return Array.isArray(found) ? found : [];
}

/** `numbers` of a list of objects with a numeric `number` field at `path`. */
export function numbersAt(value: unknown, path: string, field = "number"): number[] {
  return pickArray(value, path)
    .map((item) => pick(item, field))
    .filter((n): n is number => typeof n === "number");
}
