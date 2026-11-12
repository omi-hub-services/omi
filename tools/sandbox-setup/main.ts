// Sets up omi-hub-services/omi-sandbox and the local state for the OMI-042 live run (OMI-089).
//   github      --image <repo> --digest sha256:<hex> [--dry-run | --verify]
//                 default: apply. --dry-run reads (GET only) and prints every call it would make.
//                 --verify reads back every object and exits 1 if one is missing or weaker.
//   local-state --state-dir <dir> --image … --digest … [--deploy-approval-id <id>]
//                 creates state.db, project, project.yaml, artifacts/ (+ deploy-config.json once
//                 the PO's deploy approval ID is known). The state dir must be outside this repo.
// Run: node --import ./tools/register-ts-imports.ts tools/sandbox-setup/main.ts <command> …
// Repository settings are changed only by this script; auth is the local `gh` login. It never
// creates or decides an approval.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { z } from "zod";
import { prepareLocalState } from "./local-state.ts";
import {
  CHECK_WORKFLOW_PATH,
  DEPLOY_WORKFLOW_PATH,
  PIPELINE_MARKER,
  evaluateSandbox,
  parseSetupOptions,
  planSteps,
  projectRuleset,
  type Item,
  type Observed,
  type SetupOptions,
  type Step,
} from "./model.ts";

const ROOT = resolve(import.meta.dirname, "../..");
type Json = Record<string, unknown>;

// ── gh access: every path is checked against the sandbox repository first ────────────────────
function gh(options: SetupOptions, method: string, path: string, body?: Json): unknown {
  if (!path.startsWith(`repos/${options.repository}/`) && !/^(user|users\/[\w-]+)$/.test(path))
    throw new Error(`refused: ${method} ${path} is outside ${options.repository}`);
  try {
    const out = execFileSync(
      "gh",
      ["api", "-X", method, path, ...(body === undefined ? [] : ["--input", "-"])],
      {
        encoding: "utf8",
        input: body === undefined ? undefined : JSON.stringify(body),
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return out.trim() === "" ? null : (JSON.parse(out) as unknown);
  } catch (error) {
    const raw = (error as { stderr?: unknown }).stderr;
    const stderr = typeof raw === "string" ? raw : "";
    if (method === "GET" && /HTTP 404/.test(stderr)) return undefined;
    throw new Error(`gh api ${method} ${path} failed: ${stderr.trim().split("\n")[0] ?? ""}`, {
      cause: error,
    });
  }
}
const read = (o: SetupOptions, path: string) => gh(o, "GET", path);

const refSchema = z.looseObject({ object: z.looseObject({ sha: z.string() }) });
const fileSchema = z.looseObject({ content: z.string() });
const commitsSchema = z.array(z.looseObject({ sha: z.string() }));
const environmentSchema = z.looseObject({
  can_admins_bypass: z.boolean().optional(),
  protection_rules: z
    .array(
      z.looseObject({
        type: z.string(),
        prevent_self_review: z.boolean().optional(),
        reviewers: z
          .array(
            z.looseObject({ type: z.string(), reviewer: z.looseObject({ login: z.string() }) }),
          )
          .optional(),
      }),
    )
    .default([]),
});
const variablesSchema = z.looseObject({
  variables: z.array(z.looseObject({ name: z.string(), value: z.string() })),
});
const issuesSchema = z.array(
  z.looseObject({
    number: z.number(),
    state: z.string(),
    body: z.string().nullish(),
    pull_request: z.unknown().optional(),
  }),
);

function observe(o: SetupOptions): Observed {
  const base = `repos/${o.repository}`;
  const sha = (name: string) => {
    const raw = read(o, `${base}/git/ref/${name}`);
    return raw === undefined ? null : refSchema.parse(raw).object.sha;
  };
  const files: Record<string, string> = {};
  for (const path of [DEPLOY_WORKFLOW_PATH, CHECK_WORKFLOW_PATH]) {
    const raw = read(o, `${base}/contents/${path}?ref=main`);
    if (raw !== undefined)
      files[path] = Buffer.from(fileSchema.parse(raw).content, "base64").toString("utf8");
  }
  const commits = read(o, `${base}/commits?sha=main&path=${DEPLOY_WORKFLOW_PATH}&per_page=1`);
  const rawEnv = read(o, `${base}/environments/${o.environment}`);
  const env = rawEnv === undefined ? null : environmentSchema.parse(rawEnv);
  const reviewerRule = env?.protection_rules.find((r) => r.type === "required_reviewers");
  const list = z
    .array(z.looseObject({ id: z.number(), name: z.string() }))
    .parse(read(o, `${base}/rulesets?includes_parent=false&per_page=100`) ?? []);
  const rulesets = list
    .filter((r) => r.name.startsWith("omi-sandbox-"))
    .flatMap((r) => {
      const one = projectRuleset(read(o, `${base}/rulesets/${String(r.id)}`));
      return one === undefined ? [] : [one];
    });
  const user = z.looseObject({ id: z.number() }).parse(read(o, `users/${o.reviewer}`));
  const variables = variablesSchema.parse(read(o, `${base}/actions/variables?per_page=100`));
  const issues = issuesSchema.parse(read(o, `${base}/issues?state=all&per_page=100`) ?? []);
  const pipeline = issues.find(
    (i) => i.pull_request === undefined && i.body?.includes(PIPELINE_MARKER),
  );
  return {
    mainSha: sha("heads/main"),
    developSha: sha("heads/develop"),
    files,
    deployWorkflowCommitSha: commitsSchema.parse(commits ?? [])[0]?.sha ?? null,
    tagSha: sha(`tags/${o.tag}`),
    rulesets,
    environment:
      env === null
        ? null
        : {
            canAdminsBypass: env.can_admins_bypass ?? true,
            preventSelfReview: reviewerRule?.prevent_self_review ?? false,
            reviewers: (reviewerRule?.reviewers ?? []).map((r) => ({
              type: r.type,
              login: r.reviewer.login,
            })),
          },
    reviewerId: user.id,
    variables: Object.fromEntries(variables.variables.map((v) => [v.name, v.value])),
    pipelineIssue:
      pipeline === undefined ? null : { number: pipeline.number, open: pipeline.state === "open" },
  };
}

// ── output ───────────────────────────────────────────────────────────────────────────────────
function summarize(body: Json): string {
  return Object.entries(body)
    .map(([k, v]) => {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${text.length > 80 ? `<${String(text.length)} chars>` : text}`;
    })
    .join(" ");
}
function printItems(items: readonly Item[]): void {
  for (const i of items)
    console.log(`${i.ok ? "ok     " : i.blocker ? "BLOCKED" : "todo   "} ${i.id}: ${i.detail}`);
}

/** Extra read-backs that need more than the planned objects: effective rules and the tag's content. */
function verifyExtras(o: SetupOptions): string[] {
  const base = `repos/${o.repository}`;
  const failures: string[] = [];
  const effective = JSON.stringify(read(o, `${base}/rules/branches/main`));
  if (!/"pull_request"/.test(effective) || !effective.includes("sandbox-check"))
    failures.push("effective rules on main lack the native review or the sandbox-check check");
  const atTag = read(o, `${base}/contents/${DEPLOY_WORKFLOW_PATH}?ref=${o.tag}`);
  const content =
    atTag === undefined
      ? ""
      : Buffer.from(fileSchema.parse(atTag).content, "base64").toString("utf8");
  if (content !== o.deployWorkflow)
    failures.push(`workflow at tag ${o.tag} differs from the fixture`);
  return failures;
}

function runGithub(o: SetupOptions, mode: "apply" | "dry-run" | "verify"): number {
  const items = evaluateSandbox(observe(o), o);
  printItems(items);
  if (mode === "verify") {
    const failures = [...items.filter((i) => !i.ok).map((i) => i.id), ...verifyExtras(o)];
    console.log(failures.length === 0 ? "VERIFY OK" : `VERIFY FAILED: ${failures.join("; ")}`);
    return failures.length === 0 ? 0 : 1;
  }
  const steps = planSteps(items);
  console.log(`\n${mode === "dry-run" ? "DRY RUN — " : ""}${String(steps.length)} call(s) planned`);
  for (const [n, s] of steps.entries())
    console.log(
      `${String(n + 1).padStart(2)}. ${s.method} ${s.path}  [${s.id}] ${s.summary}\n      ${summarize(s.body)}`,
    );
  if (mode === "dry-run" || steps.length === 0) return 0;

  const created = new Map<string, string>();
  const resolveBody = (s: Step): Json =>
    JSON.parse(
      JSON.stringify(s.body).replace(
        /@sha:([\w-]+)/g,
        (_, id: string) => created.get(id) ?? "@missing",
      ),
    ) as Json;
  for (const step of steps) {
    const body = resolveBody(step);
    if (JSON.stringify(body).includes("@missing"))
      throw new Error(`${step.id}: dependency not created`);
    const response = gh(o, step.method, step.path, body) as { commit?: { sha?: string } } | null;
    if (response?.commit?.sha !== undefined) created.set(step.id, response.commit.sha);
    console.log(`done ${step.id}`);
  }
  const rest = planSteps(evaluateSandbox(observe(o), o));
  console.log(
    rest.length === 0
      ? "re-read: nothing left to change"
      : `re-read: ${String(rest.length)} step(s) remain`,
  );
  return rest.length === 0 ? 0 : 1;
}

async function runLocalState(o: SetupOptions, stateDir: string, approvalId: string | undefined) {
  if (!relative(ROOT, resolve(stateDir)).startsWith(".."))
    throw new Error("--state-dir must be outside this repository");
  let deploy;
  if (approvalId !== undefined) {
    const observed = observe(o);
    const issue = observed.pipelineIssue;
    if (issue === null || observed.tagSha === null)
      throw new Error("run the github step first: the pipeline Issue and the tag must exist");
    const actor = z.looseObject({ login: z.string() }).parse(read(o, "user"));
    deploy = {
      environment: o.environment,
      artifactDigest: o.digest,
      approvalId,
      tag: o.tag,
      workflowSha: observed.tagSha,
      issueNumber: issue.number,
      authorActor: actor.login,
    };
  }
  const result = await prepareLocalState({
    stateDir,
    repository: o.repository,
    projectNumber: 2,
    reviewer: o.reviewer,
    now: Date.now,
    newId: randomUUID,
    ...(deploy === undefined ? {} : { deploy }),
  });
  console.log(
    result.changed.length === 0
      ? "local state: nothing to change"
      : `local state changed: ${result.changed.join(", ")}`,
  );
  if (deploy === undefined)
    console.log(
      "deploy-config.json not written: pass --deploy-approval-id once the PO's deploy approval exists",
    );
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(["--dry-run", "--verify"]);
  const mode = rest.includes("--dry-run")
    ? "dry-run"
    : rest.includes("--verify")
      ? "verify"
      : "apply";
  const peeled: Record<string, string | undefined> = {};
  const values: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (flags.has(arg)) continue;
    if (arg === "--state-dir" || arg === "--deploy-approval-id") {
      peeled[arg] = rest[++i];
      continue;
    }
    values.push(arg);
  }
  const o = parseSetupOptions(
    values,
    readFileSync(resolve(ROOT, "tests/fixtures/github/sandbox-deploy.yml"), "utf8"),
    readFileSync(resolve(ROOT, "tests/fixtures/github/sandbox-check.yml"), "utf8"),
  );
  if (command === "github") return runGithub(o, mode);
  if (command === "local-state") {
    const stateDir = peeled["--state-dir"];
    if (stateDir === undefined) throw new Error("--state-dir is required");
    await runLocalState(o, stateDir, peeled["--deploy-approval-id"]);
    return 0;
  }
  throw new Error("usage: main.ts <github|local-state> --image … --digest … [--dry-run|--verify]");
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
