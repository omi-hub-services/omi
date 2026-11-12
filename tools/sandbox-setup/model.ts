// Pure part of the sandbox setup (OMI-089): desired state, comparison with what GitHub reports,
// and the ordered list of API calls that would close the gap. No I/O; main.ts reads and writes.
// One evaluation feeds three uses: the dry-run plan, the real run and `--verify`.
import { z } from "zod";

export const PRODUCTION_REPOSITORY = "omi-hub-services/omi";
export const CHECK_NAME = "sandbox-check";
export const DEPLOY_WORKFLOW_PATH = ".github/workflows/sandbox-deploy.yml";
export const CHECK_WORKFLOW_PATH = ".github/workflows/sandbox-check.yml";
export const PIPELINE_MARKER = "<!-- omi-sandbox:pipeline-report -->";
/** The sandbox Project (org Project #2, ADR-0015); the live harness guard accepts only this one. */
export const SANDBOX_PROJECT_NUMBER = 2;
const RULESET_MAIN = "omi-sandbox-main";
const RULESET_DEVELOP = "omi-sandbox-develop";
const RULESET_TAGS = "omi-sandbox-tags";

export interface SetupOptions {
  readonly repository: string;
  readonly environment: string;
  readonly reviewer: string;
  readonly tag: string;
  readonly image: string;
  readonly digest: string;
  readonly deployWorkflow: string;
  readonly checkWorkflow: string;
}

const FLAGS = ["repo", "environment", "reviewer", "tag", "image", "digest"] as const;

/** Parses the value flags; mode flags (`--dry-run`, `--verify`) are removed by the caller. */
export function parseSetupOptions(
  argv: readonly string[],
  deployWorkflow: string,
  checkWorkflow: string,
): SetupOptions {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = (argv[i] ?? "").replace(/^--/, "");
    const value = argv[i + 1];
    if (!(FLAGS as readonly string[]).includes(flag)) throw new Error(`unknown flag --${flag}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`--${flag} needs a value`);
    values[flag] = value;
  }
  const tag = values["tag"] ?? "sandbox-deploy-r1";
  if (!/^sandbox-deploy-[A-Za-z0-9._-]+$/.test(tag))
    throw new Error("--tag must look like sandbox-deploy-<name> so the tag ruleset covers it");
  const repository = values["repo"] ?? "omi-hub-services/omi-sandbox";
  if (
    !/^[\w.-]+\/[\w.-]*sandbox[\w.-]*$/i.test(repository) ||
    repository.toLowerCase() === PRODUCTION_REPOSITORY
  )
    throw new Error("sandbox repository required; the production repository is refused");
  const image = values["image"] ?? "";
  if (!/^[A-Za-z0-9./:_-]+$/.test(image)) throw new Error("--image must be an image repository");
  const digest = values["digest"] ?? "";
  if (!/^sha256:[0-9a-f]{64}$/.test(digest))
    throw new Error("--digest must be an immutable sha256:<64 lowercase hex> digest");
  return {
    repository,
    environment: values["environment"] ?? "sandbox",
    reviewer: values["reviewer"] ?? "ttin-omihub",
    tag,
    image,
    digest,
    deployWorkflow,
    checkWorkflow,
  };
}

// ── rulesets (ADR-0015: no bypass, native review on main, named check) ───────────────────────
interface Rule {
  readonly type: string;
  readonly parameters?: Record<string, unknown>;
}
export interface Ruleset {
  readonly name: string;
  readonly target: "branch" | "tag";
  readonly enforcement: "active";
  readonly bypass_actors: readonly unknown[];
  readonly conditions: { readonly ref_name: { include: string[]; exclude: string[] } };
  readonly rules: readonly Rule[];
}
export type ObservedRuleset = Ruleset & { readonly id: number };

const requiredCheck: Rule = {
  type: "required_status_checks",
  parameters: {
    strict_required_status_checks_policy: false,
    required_status_checks: [{ context: CHECK_NAME }],
  },
};
const pullRequest = (approvals: number, strict: boolean): Rule => ({
  type: "pull_request",
  parameters: {
    required_approving_review_count: approvals,
    dismiss_stale_reviews_on_push: strict,
    require_code_owner_review: false,
    require_last_push_approval: strict,
    required_review_thread_resolution: false,
  },
});
const ruleset = (name: string, target: Ruleset["target"], ref: string, rules: Rule[]): Ruleset => ({
  name,
  target,
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { include: [ref], exclude: [] } },
  rules,
});

export function desiredRulesets(): Ruleset[] {
  return [
    ruleset(RULESET_MAIN, "branch", "refs/heads/main", [
      { type: "deletion" },
      { type: "non_fast_forward" },
      pullRequest(1, true),
      requiredCheck,
    ]),
    ruleset(RULESET_DEVELOP, "branch", "refs/heads/develop", [
      { type: "deletion" },
      { type: "non_fast_forward" },
      pullRequest(0, false),
      requiredCheck,
    ]),
    ruleset(RULESET_TAGS, "tag", "refs/tags/sandbox-deploy-*", [
      { type: "deletion" },
      { type: "update" },
      { type: "non_fast_forward" },
    ]),
  ];
}

const rawRulesetSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  target: z.enum(["branch", "tag", "push"]),
  enforcement: z.string(),
  bypass_actors: z.array(z.unknown()).nullish(),
  conditions: z
    .looseObject({
      ref_name: z.looseObject({
        include: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
      }),
    })
    .nullish(),
  rules: z.array(
    z.looseObject({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() }),
  ),
});
const PARAMETER_KEYS: Record<string, readonly string[]> = {
  pull_request: [
    "required_approving_review_count",
    "dismiss_stale_reviews_on_push",
    "require_code_owner_review",
    "require_last_push_approval",
    "required_review_thread_resolution",
  ],
  required_status_checks: ["strict_required_status_checks_policy"],
};

function projectRule(rule: {
  type: string;
  parameters?: Record<string, unknown> | undefined;
}): Rule {
  const keys = PARAMETER_KEYS[rule.type];
  if (keys === undefined) return { type: rule.type };
  const parameters: Record<string, unknown> = {};
  for (const key of keys)
    if (rule.parameters?.[key] !== undefined) parameters[key] = rule.parameters[key];
  if (rule.type === "required_status_checks") {
    const checks = rule.parameters?.["required_status_checks"];
    parameters["required_status_checks"] = Array.isArray(checks)
      ? checks.map((c: unknown) => ({ context: (c as { context?: unknown }).context }))
      : [];
  }
  return { type: rule.type, parameters };
}

/**
 * Compares the rules GitHub enforces on `main` (`GET rules/branches/main`) with the rules the
 * main ruleset sets, by parsed parameters. Returns one failure per missing or weaker rule.
 */
export function effectiveRuleFailures(raw: unknown): string[] {
  const parsed = z
    .array(
      z.looseObject({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() }),
    )
    .safeParse(raw);
  if (!parsed.success) return ["effective rules on main could not be read"];
  const have = parsed.data.map(projectRule);
  const want = desiredRulesets().find((r) => r.name === RULESET_MAIN)?.rules ?? [];
  return want
    .filter((rule) => !have.some((h) => sameJson(h, rule)))
    .map((rule) => `effective rules on main lack or weaken ${rule.type}`);
}

/** Items still unsatisfied, blockers included; unlike planSteps it never throws. */
export const remainingItemIds = (items: readonly Item[]): string[] =>
  items.filter((i) => !i.ok).map((i) => i.id);

/**
 * GitHub reads can lag right after writes. Re-reads up to `attempts` times, sleeping `delayMs`
 * between reads, and returns the ids still unsatisfied after the last read.
 */
export async function settleAfterApply(deps: {
  read: () => Item[];
  attempts: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<string[]> {
  let remaining: string[] = [];
  for (let attempt = 1; attempt <= deps.attempts; attempt++) {
    remaining = remainingItemIds(deps.read());
    if (remaining.length === 0 || attempt === deps.attempts) break;
    await deps.sleep(deps.delayMs);
  }
  return remaining;
}

/** Reduces a GitHub ruleset response to the fields this script sets, so defaults never show as drift. */
export function projectRuleset(raw: unknown): ObservedRuleset | undefined {
  const parsed = rawRulesetSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const target = parsed.data.target;
  if (target === "push") return undefined;
  const data = parsed.data;
  const rules = data.rules.map(projectRule);
  return {
    id: data.id,
    name: data.name,
    target,
    enforcement: data.enforcement as "active",
    bypass_actors: data.bypass_actors ?? [],
    conditions: { ref_name: data.conditions?.ref_name ?? { include: [], exclude: [] } },
    rules,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    return items.every((i) => typeof i === "object")
      ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items;
  }
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// ── environment (ADR-0015: required reviewer, no self review, no admin bypass) ───────────────
export interface ObservedEnvironment {
  readonly canAdminsBypass: boolean;
  readonly preventSelfReview: boolean;
  readonly reviewers: readonly { type: string; login: string }[];
}
export function desiredEnvironment(reviewerId: number) {
  return {
    wait_timer: 0,
    prevent_self_review: true,
    can_admins_bypass: false,
    reviewers: [{ type: "User", id: reviewerId }],
    deployment_branch_policy: null,
  };
}

// ── evaluation ───────────────────────────────────────────────────────────────────────────────
export interface Observed {
  readonly mainSha: string | null;
  readonly developSha: string | null;
  /** Decoded content on `main`, by path; absent = file missing. */
  readonly files: Readonly<Record<string, string>>;
  /** Newest commit on `main` touching the deploy workflow. */
  readonly deployWorkflowCommitSha: string | null;
  readonly tagSha: string | null;
  readonly rulesets: readonly ObservedRuleset[];
  readonly environment: ObservedEnvironment | null;
  readonly reviewerId: number;
  readonly variables: Readonly<Record<string, string>>;
  readonly pipelineIssue: { readonly number: number; readonly open: boolean } | null;
}

export interface Step {
  readonly id: string;
  readonly method: "POST" | "PUT" | "PATCH";
  readonly path: string;
  /** A value `@sha:<stepId>` is replaced with the commit SHA that step created. */
  readonly body: Record<string, unknown>;
  readonly summary: string;
}
export interface Item {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly step?: Step;
  /** The gap cannot be closed safely by this script; a human decides. */
  readonly blocker?: string;
}

export function evaluateSandbox(observed: Observed, options: SetupOptions): Item[] {
  const base = `repos/${options.repository}`;
  const items: Item[] = [];
  const done = (id: string, detail: string): Item => ({ id, ok: true, detail });
  const todo = (step: Step, detail: string): Item => ({ id: step.id, ok: false, detail, step });
  const blocked = (id: string, detail: string, blocker: string): Item => ({
    id,
    ok: false,
    detail,
    blocker,
  });

  if (observed.developSha !== null) items.push(done("branch-develop", "branch develop exists"));
  else if (observed.mainSha === null)
    items.push(blocked("branch-develop", "develop missing", "main has no commit to branch from"));
  else
    items.push(
      todo(
        {
          id: "branch-develop",
          method: "POST",
          path: `${base}/git/refs`,
          body: { ref: "refs/heads/develop", sha: observed.mainSha },
          summary: "create branch develop from main",
        },
        "branch develop missing",
      ),
    );

  const file = (id: string, path: string, content: string, message: string): Item => {
    const current = observed.files[path];
    if (current === content) return done(id, `${path} matches the reviewed fixture`);
    if (current !== undefined)
      return blocked(
        id,
        `${path} differs`,
        `${path} differs from the fixture; change it through a reviewed PR`,
      );
    return todo(
      {
        id,
        method: "PUT",
        path: `${base}/contents/${path}`,
        body: { message, content: Buffer.from(content).toString("base64"), branch: "main" },
        summary: `commit ${path} to main (${String(content.length)} chars)`,
      },
      `${path} missing`,
    );
  };
  const deployFile = file(
    "file-deploy-workflow",
    DEPLOY_WORKFLOW_PATH,
    options.deployWorkflow,
    "ci: add sandbox deploy workflow (OMI-089)",
  );
  items.push(deployFile);

  const tagRef = `refs/tags/${options.tag}`;
  const expectedTagSha = deployFile.ok
    ? observed.deployWorkflowCommitSha
    : "@sha:file-deploy-workflow";
  if (deployFile.blocker !== undefined)
    items.push(blocked("tag-deploy-workflow", "tag not evaluated", "deploy workflow is blocked"));
  else if (expectedTagSha === null)
    items.push(
      blocked("tag-deploy-workflow", "no commit found", "no commit touches the deploy workflow"),
    );
  else if (observed.tagSha === null)
    items.push(
      todo(
        {
          id: "tag-deploy-workflow",
          method: "POST",
          path: `${base}/git/refs`,
          body: { ref: tagRef, sha: expectedTagSha },
          summary: `create lightweight tag ${options.tag} at the deploy workflow commit`,
        },
        `tag ${options.tag} missing`,
      ),
    );
  else if (observed.tagSha === expectedTagSha)
    items.push(done("tag-deploy-workflow", `tag ${options.tag} points at the workflow commit`));
  else
    items.push(
      blocked(
        "tag-deploy-workflow",
        `tag ${options.tag} points elsewhere`,
        `tag ${options.tag} exists at another commit; tags are never moved, choose a new --tag`,
      ),
    );

  items.push(
    file(
      "file-check-workflow",
      CHECK_WORKFLOW_PATH,
      options.checkWorkflow,
      "ci: add sandbox check workflow (OMI-089)",
    ),
  );

  const variable = (id: string, name: string, value: string): Item => {
    const current = observed.variables[name];
    if (current === value) return done(id, `variable ${name} is set`);
    return todo(
      current === undefined
        ? {
            id,
            method: "POST",
            path: `${base}/actions/variables`,
            body: { name, value },
            summary: `create variable ${name}`,
          }
        : {
            id,
            method: "PATCH",
            path: `${base}/actions/variables/${name}`,
            body: { name, value },
            summary: `update variable ${name}`,
          },
      current === undefined ? `variable ${name} missing` : `variable ${name} differs`,
    );
  };
  items.push(variable("variable-image", "OMI_SANDBOX_IMAGE", options.image));
  items.push(variable("variable-digest", "OMI_SANDBOX_IMAGE_DIGEST", options.digest));

  const env = observed.environment;
  const envOk =
    env !== null &&
    !env.canAdminsBypass &&
    env.preventSelfReview &&
    env.reviewers.length === 1 &&
    env.reviewers[0]?.type === "User" &&
    env.reviewers[0].login.toLowerCase() === options.reviewer.toLowerCase();
  items.push(
    envOk
      ? done("environment", `environment ${options.environment} requires ${options.reviewer}`)
      : todo(
          {
            id: "environment",
            method: "PUT",
            path: `${base}/environments/${options.environment}`,
            body: desiredEnvironment(observed.reviewerId),
            summary: `set environment ${options.environment}: reviewer ${options.reviewer}, prevent_self_review, no admin bypass`,
          },
          `environment ${options.environment} missing or too weak`,
        ),
  );

  for (const want of desiredRulesets()) {
    const id = `ruleset-${want.name.replace("omi-sandbox-", "")}`;
    const have = observed.rulesets.find((r) => r.name === want.name);
    if (have !== undefined) {
      // `id` is undefined here and dropped by JSON, so only the fields we set are compared.
      if (sameJson({ ...have, id: undefined }, want)) {
        items.push(done(id, `ruleset ${want.name} matches`));
        continue;
      }
    }
    items.push(
      todo(
        have === undefined
          ? {
              id,
              method: "POST",
              path: `${base}/rulesets`,
              body: { ...want },
              summary: `create ruleset ${want.name} (no bypass actors)`,
            }
          : {
              id,
              method: "PUT",
              path: `${base}/rulesets/${String(have.id)}`,
              body: { ...want },
              summary: `replace ruleset ${want.name} (no bypass actors)`,
            },
        have === undefined ? `ruleset ${want.name} missing` : `ruleset ${want.name} drifted`,
      ),
    );
  }

  const issue = observed.pipelineIssue;
  if (issue === null)
    items.push(
      todo(
        {
          id: "issue-pipeline",
          method: "POST",
          path: `${base}/issues`,
          body: {
            title: "[omi-sandbox] Deploy pipeline report",
            body: `${PIPELINE_MARKER}\nReport Issue for the OMI-042 live deploy. The runtime comments here when a deploy waits or fails.`,
          },
          summary: "create the pipeline/report Issue",
        },
        "pipeline Issue missing",
      ),
    );
  else if (issue.open)
    items.push(done("issue-pipeline", `pipeline Issue #${String(issue.number)} is open`));
  else
    items.push(
      blocked(
        "issue-pipeline",
        `pipeline Issue #${String(issue.number)} is closed`,
        `reopen Issue #${String(issue.number)}`,
      ),
    );
  return items;
}

/** The calls that close the gap, in dependency order; throws when a human must decide first. */
export function planSteps(items: readonly Item[]): Step[] {
  const blockers = items
    .filter((i) => i.blocker !== undefined)
    .map((i) => `${i.id}: ${i.blocker ?? ""}`);
  if (blockers.length > 0) throw new Error(`setup blocked: ${blockers.join("; ")}`);
  return items.flatMap((i) => (i.ok || i.step === undefined ? [] : [i.step]));
}
