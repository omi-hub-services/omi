// OMI-006 — pure part of the live GitHub capability probe: argument parsing and the
// production guard, outcome classification, redaction and the capability matrix. No I/O here, so
// tests/unit/live/github/ can cover it. Test-only code: the production adapters (OMI-019, OMI-022,
// OMI-024) live in src/infrastructure/github/ and must not import it.

export type StepResult = "supported" | "unsupported" | "partial" | "error";
export type Phase = "setup" | "approve" | "verify" | "cleanup";
export const PHASES: readonly Phase[] = ["setup", "approve", "verify", "cleanup"];

/**
 * `success`: the call should work. `denied`: a gate should refuse it (a refusal is `supported`,
 * acceptance is `unsupported`). `observe`: the step reads a fact and decides the result itself.
 */
export type Expectation = "success" | "denied" | "observe";

/** Production coordinates that the probe must never touch. */
export const PRODUCTION_REPO = "omi-hub-services/omi";
export const PRODUCTION_PROJECT_NUMBER = 1;

const REPO_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
// `omi-hub-services/omi` not followed by a name character: matches `…/omi`, `…/omi/issues/1`,
// `…/omi#3` and `repos/omi-hub-services/omi/…`, but not `omi-hub-services/omi-sandbox`.
const PRODUCTION_SLUG_IN_TEXT = /omi-hub-services\/omi(?![A-Za-z0-9._-])/i;

export interface SandboxTarget {
  readonly repo: string;
  readonly projectOwner: string;
  readonly projectNumber: number;
}

/** Throws unless the target is a well-formed, non-production repository and Project. */
export function assertSandboxTarget(target: SandboxTarget): void {
  if (!REPO_SLUG.test(target.repo)) {
    throw new Error(`--repo must be OWNER/NAME, got "${target.repo}"`);
  }
  if (target.repo.toLowerCase() === PRODUCTION_REPO) {
    throw new Error(`refusing to run against the production repository ${PRODUCTION_REPO}`);
  }
  if (!LOGIN.test(target.projectOwner)) {
    throw new Error(`--project-owner must be a GitHub login, got "${target.projectOwner}"`);
  }
  if (!Number.isInteger(target.projectNumber) || target.projectNumber < 1) {
    throw new Error(`--project must be a positive integer, got ${String(target.projectNumber)}`);
  }
  if (target.projectNumber === PRODUCTION_PROJECT_NUMBER) {
    throw new Error(
      `refusing to run against Project #${String(PRODUCTION_PROJECT_NUMBER)} (production)`,
    );
  }
}

/**
 * Second line of defence, applied to every gh call: no argument or stdin body may name the
 * production repository, and `gh project <sub> <number>` must use the sandbox Project number.
 */
export function assertSandboxCall(
  args: readonly string[],
  input: string | undefined,
  target: SandboxTarget,
): void {
  for (const arg of args) {
    if (PRODUCTION_SLUG_IN_TEXT.test(arg)) {
      throw new Error(`refusing gh call that names ${PRODUCTION_REPO}: ${arg}`);
    }
  }
  if (input !== undefined && PRODUCTION_SLUG_IN_TEXT.test(input)) {
    throw new Error(`refusing gh call whose request body names ${PRODUCTION_REPO}`);
  }
  if (args[0] === "project") {
    const positional = args[2];
    if (positional !== undefined && /^\d+$/.test(positional)) {
      if (Number(positional) !== target.projectNumber) {
        throw new Error(
          `refusing gh project call on Project #${positional}; sandbox is #${String(target.projectNumber)}`,
        );
      }
    }
  }
}

export interface ProbeArgs {
  readonly command: Phase | "matrix";
  readonly evidencePath: string;
  readonly statePath: string | undefined;
  readonly target: SandboxTarget | undefined;
  readonly approver: string | undefined;
  readonly waitSeconds: number;
  readonly deleteIssues: boolean;
  readonly deleteFields: boolean;
  readonly force: boolean;
}

export const USAGE = `Usage:
  node tests/live/github/main.ts setup   --repo OWNER/NAME --project N --approver LOGIN --state FILE --evidence FILE [--project-owner LOGIN] [--wait-seconds N] [--force]
  node tests/live/github/main.ts approve --state FILE --evidence FILE [--wait-seconds N]
  node tests/live/github/main.ts verify  --state FILE --evidence FILE [--wait-seconds N]
  node tests/live/github/main.ts cleanup --state FILE --evidence FILE [--delete-issues] [--delete-fields]
  node tests/live/github/main.ts matrix  --evidence FILE`;

const VALUE_FLAGS = new Set([
  "--repo",
  "--project",
  "--project-owner",
  "--approver",
  "--state",
  "--evidence",
  "--wait-seconds",
]);
const BOOLEAN_FLAGS = new Set(["--delete-issues", "--delete-fields", "--force"]);

/** Parses argv (without `node main.ts`). Throws with a message on any invalid input. */
export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const [first, ...rest] = argv;
  const command = first === "matrix" ? first : PHASES.find((phase) => phase === first);
  if (command === undefined) throw new Error(`unknown command "${first ?? ""}"\n${USAGE}`);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.add(arg);
    } else if (VALUE_FLAGS.has(arg)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      values.set(arg, value);
      i += 1;
    } else {
      throw new Error(`unknown argument "${arg}"\n${USAGE}`);
    }
  }
  const evidencePath = values.get("--evidence");
  if (evidencePath === undefined) throw new Error(`--evidence is required\n${USAGE}`);
  const statePath = values.get("--state");
  if (command !== "matrix" && statePath === undefined) {
    throw new Error(`--state is required for ${command}\n${USAGE}`);
  }
  const waitText = values.get("--wait-seconds") ?? "600";
  const waitSeconds = Number(waitText);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 10) {
    throw new Error(`--wait-seconds must be an integer >= 10, got "${waitText}"`);
  }

  let target: SandboxTarget | undefined;
  let approver: string | undefined;
  if (command === "setup") {
    const repo = values.get("--repo");
    const project = values.get("--project");
    approver = values.get("--approver");
    if (repo === undefined || project === undefined || approver === undefined) {
      throw new Error(`setup needs --repo, --project and --approver\n${USAGE}`);
    }
    if (!LOGIN.test(approver)) throw new Error(`--approver must be a GitHub login`);
    target = {
      repo,
      projectOwner: values.get("--project-owner") ?? repo.split("/")[0] ?? "",
      projectNumber: /^\d+$/.test(project) ? Number(project) : Number.NaN,
    };
    assertSandboxTarget(target);
  } else if (["--repo", "--project", "--project-owner", "--approver"].some((f) => values.has(f))) {
    throw new Error(`${command} reads repo, Project and approver from --state; do not pass them`);
  }

  return {
    command: command,
    evidencePath,
    statePath,
    target,
    approver,
    waitSeconds,
    deleteIssues: flags.has("--delete-issues"),
    deleteFields: flags.has("--delete-fields"),
    force: flags.has("--force"),
  };
}

/**
 * Removes tokens and e-mail addresses from text that goes into evidence. Commit SHAs and node IDs
 * are kept on purpose (they are evidence, not secrets), so there is no "long opaque string" rule.
 */
export function redact(text: string): string {
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "[REDACTED_TOKEN]")
    .replace(/\b(authorization\s*[:=]\s*)(?:bearer|token)\s+\S+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [REDACTED]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]");
}

const SAFE_WORD = /^[A-Za-z0-9_/.:=@%+,{}?&-]+$/;

/** Display form of a gh call for evidence; the stdin body is appended (it never holds tokens). */
export function formatCall(args: readonly string[], input: string | undefined): string {
  const line = ["gh", ...args]
    .map((arg) => (SAFE_WORD.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(" ");
  const body =
    input === undefined ? "" : ` <<< ${input.length > 600 ? `${input.slice(0, 600)}…` : input}`;
  return redact(line + body);
}

/** `gh api` prints `gh: <message> (HTTP 422)`; returns the status or null. */
export function httpStatusOf(text: string): number | null {
  const matches = [...text.matchAll(/\(HTTP (\d{3})\)/g)];
  const last = matches.at(-1);
  return last?.[1] === undefined ? null : Number(last[1]);
}

/** GraphQL `errors[].message` from a gh api graphql stdout, or [] when there are none. */
export function graphqlErrorMessages(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const errors = (parsed as Record<string, unknown>)["errors"];
  if (!Array.isArray(errors)) return [];
  return errors.map((error: unknown) => {
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = error.message;
      return typeof message === "string" ? message : "unknown GraphQL error";
    }
    return "unknown GraphQL error";
  });
}

export interface CallOutcome {
  /** Exit code; 127 when gh could not start, 124 on timeout. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface Verdict {
  readonly result: StepResult;
  readonly note: string;
}

const UNAVAILABLE =
  /not available|not enabled|upgrade to|github (team|pro|enterprise)|feature is not|unknown (field|command|flag)|doesn't exist on type|accepts at most|not found/i;
const MALFORMED_CALL =
  /unknown (flag|command|shorthand flag)|doesn't exist on type|required flag|accepts \d+ arg|invalid argument|Problems parsing JSON/i;
const TRANSIENT =
  /timed? ?out|connection (reset|refused)|could not resolve host|\bEOF\b|tls handshake|temporary failure|\(HTTP 5\d\d\)/i;

/** Short, redacted error text: stderr first, then GraphQL errors, then stdout. */
export function errorText(outcome: CallOutcome): string {
  const graphql = graphqlErrorMessages(outcome.stdout);
  const text = [outcome.stderr.trim(), ...graphql].filter((s) => s !== "").join(" | ");
  const chosen = text === "" ? outcome.stdout.trim() : text;
  return redact(chosen.length > 800 ? `${chosen.slice(0, 800)}…` : chosen);
}

/**
 * Turns a gh call outcome into a step result.
 * - Could not start, timed out or transient (5xx/network) → `error` in every mode.
 * - `success`: exit 0 (and no GraphQL errors) → the verifier's verdict or `supported`; HTTP
 *   404/410 or a "not available"-style message → `unsupported`; anything else → `error`.
 * - `denied`: a non-zero exit with an HTTP 4xx or a refusal message → `supported` (the gate held);
 *   exit 0 → the verifier's verdict (some endpoints answer 200 without acting) or `unsupported`.
 */
export function classifyOutcome(
  expect: "success" | "denied",
  outcome: CallOutcome,
  verify?: (stdout: string) => Verdict,
): Verdict {
  const graphql = graphqlErrorMessages(outcome.stdout);
  const failed = outcome.code !== 0 || graphql.length > 0;
  const text = errorText(outcome);
  const status = httpStatusOf(outcome.stderr);
  if (outcome.code === 127) return { result: "error", note: `gh could not start: ${text}` };
  if (outcome.timedOut) return { result: "error", note: `timed out: ${text}` };
  if (failed && (TRANSIENT.test(text) || (status !== null && status >= 500))) {
    return { result: "error", note: `transient failure: ${text}` };
  }

  if (expect === "success") {
    if (!failed)
      return verify === undefined ? { result: "supported", note: "" } : verify(outcome.stdout);
    if (status === 404 || status === 410 || UNAVAILABLE.test(text)) {
      return { result: "unsupported", note: text };
    }
    return { result: "error", note: text };
  }

  if (failed) {
    // A malformed call is not a gate refusing it.
    if (MALFORMED_CALL.test(text)) return { result: "error", note: `malformed call: ${text}` };
    const refused = (status !== null && status >= 400 && status < 500) || text !== "";
    return refused
      ? { result: "supported", note: `refused as expected: ${text}` }
      : { result: "error", note: "failed without any error text" };
  }
  return verify === undefined
    ? { result: "unsupported", note: "the call was accepted; the gate did not refuse it" }
    : verify(outcome.stdout);
}

/** Scopes of the active account from `gh auth status --active` output; never the token. */
export function parseTokenScopes(authStatus: string): string[] | null {
  const line = authStatus.split(/\r?\n/).find((l) => /Token scopes:/i.test(l));
  if (line === undefined) return null;
  return [...line.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "").filter((s) => s !== "");
}

export interface StepRecord {
  readonly id: string;
  readonly capability: string;
  readonly phase: Phase;
  readonly actor: string;
  /** Short API form for the matrix, e.g. `REST POST /repos/{r}/issues/{n}/sub_issues`. */
  readonly api: string;
  /** Exact redacted command line, with the stdin body if any. */
  readonly command: string;
  readonly expect: Expectation;
  readonly result: StepResult;
  readonly httpStatus: number | null;
  readonly exitCode: number | null;
  readonly detail: string;
  /** Small allowlisted facts read back (state, counts, logins); never raw payloads. */
  readonly observed: Readonly<Record<string, string | number | boolean | null>>;
  readonly at: string;
  readonly durationMs: number;
}

export interface PhaseRun {
  readonly phase: Phase;
  readonly actor: string;
  readonly startedAt: string;
  finishedAt?: string;
  readonly environment: Readonly<Record<string, string | null>>;
  aborted?: string;
}

export interface Evidence {
  readonly task: "OMI-006";
  readonly schemaVersion: 1;
  readonly repo: string;
  readonly projectOwner: string;
  readonly projectNumber: number;
  readonly runId: string;
  readonly phases: PhaseRun[];
  readonly steps: StepRecord[];
}

export interface Capability {
  readonly id: string;
  readonly title: string;
  /** Which later task relies on it, and the fallback if GitHub does not support it. */
  readonly consequence: string;
}

/** Matrix rows, in ADR order. Every probe step names one of these ids. */
export const CAPABILITIES = [
  {
    id: "env.actor",
    title: "Actor, token scopes, repo permission, org plan",
    consequence: "OMI-019 `doctor`: verify identity/scopes before init; refuse on missing scope",
  },
  {
    id: "project.read-fields",
    title: "Project v2: read Project and fields",
    consequence: "OMI-019 maps fields by ID; no fallback needed if supported",
  },
  {
    id: "project.create-field",
    title: "Project v2: create a field",
    consequence: "OMI-019 init creates missing fields; fallback: PO creates them on the UI",
  },
  {
    id: "project.add-item",
    title: "Project v2: add an Issue as item",
    consequence: "OMI-024 outbox adds items; fallback: built-in auto-add workflow",
  },
  {
    id: "project.value.single-select",
    title: "Project v2: write/read single-select (incl. Status)",
    consequence: "OMI-024 Status sync; no fallback (Status is the source of task state)",
  },
  {
    id: "project.value.text",
    title: "Project v2: write/read text",
    consequence: "OMI-024 Plan Key / Run ID / Blocked Reason",
  },
  {
    id: "project.value.number",
    title: "Project v2: write/read number",
    consequence: "OMI-024 numeric fields (none required today)",
  },
  {
    id: "project.value.date",
    title: "Project v2: write/read date",
    consequence: "OMI-024 date fields (none required today)",
  },
  {
    id: "issue.create",
    title: "Issue: create",
    consequence: "OMI-020/OMI-024 create Issues through the outbox",
  },
  {
    id: "issue.sub-issue.add",
    title: "Sub-issue: add",
    consequence: "OMI-024 writes parent/sub-issue; fallback: task list in parent body",
  },
  {
    id: "issue.sub-issue.list",
    title: "Sub-issue: list (and parent)",
    consequence: "OMI-020 imports hierarchy; OMI-024 reconciles",
  },
  {
    id: "issue.sub-issue.remove",
    title: "Sub-issue: remove",
    consequence: "OMI-024 reconciliation when scope changes",
  },
  {
    id: "issue.dependency.add",
    title: "Native dependency (blocked-by): add",
    consequence: "OMI-024 writes dependencies; fallback: `Blocked by #N` text + Blocked Reason",
  },
  {
    id: "issue.dependency.list",
    title: "Native dependency: list blocked-by/blocking",
    consequence: "OMI-020 import and scheduler readiness (OMI-025)",
  },
  {
    id: "issue.dependency.remove",
    title: "Native dependency: remove",
    consequence: "OMI-024 reconciliation",
  },
  {
    id: "issue.close",
    title: "Issue: close with reason",
    consequence: "OMI-024 closes Issues after a verified merge",
  },
  {
    id: "pr.branch-commit",
    title: "Branch + commit through the API (no clone)",
    consequence: "Probe plumbing only; OMI-021/OMI-022 push from the worktree with git",
  },
  {
    id: "pr.create",
    title: "PR: create",
    consequence: "OMI-022 opens task PRs",
  },
  {
    id: "pr.link.closing-keyword",
    title: "PR→Issue link: closing keyword, PR into default branch",
    consequence: "OMI-022 release PRs into `main`",
  },
  {
    id: "pr.link.non-default-base",
    title: "PR→Issue link: closing keyword, PR into non-default branch",
    consequence:
      "OMI-022 task PRs into `develop`: GitHub does not link or close; use `Issue: #N` (timeline read-back) and OMI-024 closes the Issue after the verified merge",
  },
  {
    id: "pr.link.explicit-reference",
    title: "PR→Issue link: explicit `Issue: #N` read back",
    consequence: "OMI-022 canonical link; read back via timeline cross-reference",
  },
  {
    id: "pr.merge-permission",
    title: "PR: merge permission and mergeability",
    consequence: "OMI-023 merge gate reads these before merging",
  },
  {
    id: "pr.merge",
    title: "PR: merge when all gates pass",
    consequence: "OMI-023 merges through the API",
  },
  {
    id: "approval.ruleset",
    title: "Ruleset: 1 approval + required check (Free plan, public repo)",
    consequence: "OMI-019 doctor / OMI-023 rely on server-side enforcement",
  },
  {
    id: "approval.blocks-merge",
    title: "Required approval blocks merge until approved",
    consequence: "OMI-023/OMI-029 can trust native approval as a hard gate",
  },
  {
    id: "approval.self-approval-denied",
    title: "PR author cannot approve own PR",
    consequence: "OMI-029: agent identity can never satisfy PO approval",
  },
  {
    id: "approval.other-actor",
    title: "Second actor approves; reviewDecision read back",
    consequence: "OMI-029 reads approval actor + head from GitHub",
  },
  {
    id: "approval.admin-bypass-denied",
    title: "Repo admin cannot bypass the ruleset",
    consequence: "OMI-023: no bypass actor means gates hold for admins too",
  },
  {
    id: "checks.workflow",
    title: "Actions workflow reports a check run",
    consequence: "OMI-023 / OMI-036 CI workflows; writing workflow files needs `workflow` scope",
  },
  {
    id: "checks.required-blocks",
    title: "Required status check blocks merge until green",
    consequence: "OMI-023 can rely on server-side check enforcement",
  },
  {
    id: "checks.read",
    title: "Read check runs: check-runs API vs `gh pr checks`",
    consequence: "OMI-023 picks the read path pinned to the head SHA",
  },
  {
    id: "deploy.environment",
    title: "Environment with required reviewer + prevent_self_review",
    consequence: "OMI-040 production approval gate",
  },
  {
    id: "deploy.job-waits",
    title: "Job targeting the environment waits for approval",
    consequence: "OMI-040/OMI-041 dispatch then wait",
  },
  {
    id: "deploy.non-reviewer-denied",
    title: "Non-reviewer (admin) cannot approve the deployment",
    consequence: "OMI-040: only listed reviewers approve",
  },
  {
    id: "deploy.reviewer-approves",
    title: "Listed reviewer approves; job runs",
    consequence: "OMI-040: PO approves on GitHub",
  },
  {
    id: "deploy.self-review-denied",
    title: "prevent_self_review: triggering reviewer cannot approve",
    consequence: "OMI-040: the PO must not trigger the deploy they approve",
  },
  {
    id: "deploy.state-read",
    title: "Read deployment gate state and approvals",
    consequence: "OMI-040/OMI-024 reconcile deploy state",
  },
  {
    id: "cleanup",
    title: "Cleanup leaves the sandbox reusable",
    consequence: "Probe re-runnable; no product consequence",
  },
] as const satisfies readonly Capability[];

/** Matrix row ids as a type: a typo in a probe step fails `npm run typecheck`. */
export type CapabilityId = (typeof CAPABILITIES)[number]["id"];

export type MatrixResult = StepResult | "pending live run";

export interface MatrixRow {
  readonly capability: Capability;
  readonly api: string[];
  readonly actors: string[];
  readonly result: MatrixResult;
  readonly evidence: string[];
}

/**
 * One row per capability. All steps `supported` → supported; all `unsupported` → unsupported;
 * all `error` → error; any mix → partial; no step → pending live run.
 */
export function aggregateResult(results: readonly StepResult[]): MatrixResult {
  if (results.length === 0) return "pending live run";
  const first = results[0];
  if (first !== undefined && results.every((r) => r === first)) return first;
  return "partial";
}

export function buildMatrixRows(steps: readonly StepRecord[]): MatrixRow[] {
  return CAPABILITIES.map((capability) => {
    const own = steps.filter((step) => step.capability === capability.id);
    return {
      capability,
      api: [...new Set(own.map((step) => step.api))],
      actors: [...new Set(own.map((step) => step.actor))],
      result: aggregateResult(own.map((step) => step.result)),
      evidence: own.map((step) => {
        const status = step.httpStatus === null ? "" : ` HTTP ${String(step.httpStatus)}`;
        return `${step.id}: ${step.result}${status}`;
      }),
    };
  });
}

/** Steps whose capability id is not in CAPABILITIES (a probe bug, reported by `matrix`). */
export function unknownCapabilities(steps: readonly StepRecord[]): string[] {
  const known = new Set<string>(CAPABILITIES.map((c) => c.id));
  return [...new Set(steps.map((s) => s.capability).filter((id) => !known.has(id)))];
}

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

export function renderMatrixMarkdown(rows: readonly MatrixRow[]): string {
  const header =
    "| Capability | API/command | Actor | Result | Evidence | Consequence for omi-squad |\n" +
    "| ---------- | ----------- | ----- | ------ | -------- | ------------------------- |";
  const lines = rows.map((row) =>
    [
      row.capability.title,
      row.api.join("; ") || "—",
      row.actors.join(", ") || "—",
      row.result,
      row.evidence.join("; ") || "—",
      row.capability.consequence,
    ]
      .map(cell)
      .join(" | "),
  );
  return [header, ...lines.map((line) => `| ${line} |`)].join("\n");
}
