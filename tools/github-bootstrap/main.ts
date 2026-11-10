// One-off bootstrap of the omi GitHub backlog from docs/planning/github-backlog.yaml.
//   node tools/github-bootstrap/main.ts validate   offline: manifest + cross-check with project-plan.md
//   node tools/github-bootstrap/main.ts plan       read-only: what apply would create/update
//   node tools/github-bootstrap/main.ts apply      upsert milestones, issues, sub-issues,
//                                                  dependencies, Project, fields and items
// Idempotent: issues are matched by the plan-key marker in their body (never by title),
// milestones by title, Project by title under the owner. Journal and ID mapping go to
// .tmp/github-bootstrap/ (gitignored, no tokens). Auth comes from the local `gh` login.
// ponytail: deliberately not a general importer; omi-squad's real importer is OMI-019/020.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareWithPlan,
  issueTitle,
  MARKER_PATTERN,
  parseManifest,
  parsePlan,
  renderBody,
  validateManifest,
  WORK_TYPE,
  type IssueRef,
  type Manifest,
  type ManifestIssue,
} from "./manifest.ts";

const MANIFEST = "docs/planning/github-backlog.yaml";
const PLAN = "docs/planning/project-plan.md";
const OUT = ".tmp/github-bootstrap";

type Json = Record<string, unknown>;

function load(): Manifest {
  const manifest = parseManifest(readFileSync(MANIFEST, "utf8"));
  const errors = [
    ...validateManifest(manifest),
    ...compareWithPlan(manifest, parsePlan(readFileSync(PLAN, "utf8"))),
  ];
  if (errors.length > 0) {
    console.error(`${MANIFEST}: ${String(errors.length)} error(s)`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  return manifest;
}

// ── gh access ────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gh(args: string[], input?: unknown): unknown {
  const stdout = execFileSync("gh", args, {
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return stdout.trim() ? (JSON.parse(stdout) as unknown) : null;
}

const rest = (method: string, path: string, body?: Json) =>
  gh(["api", "-X", method, path, ...(body ? ["--input", "-"] : [])], body);

function restAll(path: string): Json[] {
  // --slurp yields one array per page.
  const pages = gh(["api", "--paginate", "--slurp", path]) as Json[][];
  return pages.flat();
}

const graphql = (query: string, variables: Json = {}) =>
  (gh(["api", "graphql", "--input", "-"], { query, variables }) as { data: Json }).data;

function journal(event: Json) {
  appendFileSync(
    join(OUT, "journal.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
  );
}

// Content-creating calls are paced to stay under GitHub's secondary rate limits.
async function write<T>(what: string, call: () => T): Promise<T> {
  journal({ intent: what });
  const result = call();
  journal({ done: what });
  await sleep(700);
  return result;
}

// ── remote state ─────────────────────────────────────────────────────────────
interface RemoteIssue {
  id: number;
  node_id: string;
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  milestone: { number: number } | null;
  pull_request?: unknown;
}

function remoteIssues(repo: string): Map<string, RemoteIssue> {
  const found = new Map<string, RemoteIssue>();
  for (const raw of restAll(`repos/${repo}/issues?state=all&per_page=100`)) {
    const issue = raw as unknown as RemoteIssue;
    if (issue.pull_request) continue;
    const key = MARKER_PATTERN.exec(issue.body ?? "")?.[1];
    if (!key) continue;
    const dup = found.get(key);
    if (dup)
      throw new Error(
        `duplicate remote issues for ${key}: #${String(dup.number)} and #${String(issue.number)}`,
      );
    found.set(key, issue);
  }
  return found;
}

function remoteMilestones(repo: string): Map<string, number> {
  return new Map(
    restAll(`repos/${repo}/milestones?state=all&per_page=100`).map((m) => [
      String(m.title),
      Number(m.number),
    ]),
  );
}

// ── apply steps ──────────────────────────────────────────────────────────────
async function upsertMilestones(
  m: Manifest,
  repo: string,
  dry: boolean,
): Promise<Map<string, number>> {
  const existing = remoteMilestones(repo);
  const byKey = new Map<string, number>();
  for (const ms of m.milestones) {
    let number = existing.get(ms.title);
    if (number === undefined) {
      console.log(`milestone create: ${ms.title}`);
      if (dry) continue;
      number = Number(
        (
          (await write(`milestone:${ms.key}`, () =>
            rest("POST", `repos/${repo}/milestones`, {
              title: ms.title,
              description: ms.description,
            }),
          )) as Json
        ).number,
      );
    } else console.log(`milestone reuse: ${ms.title} (#${String(number)})`);
    byKey.set(ms.key, number);
  }
  return byKey;
}

async function upsertIssues(
  m: Manifest,
  repo: string,
  milestones: ReadonlyMap<string, number>,
  dry: boolean,
): Promise<Map<string, RemoteIssue>> {
  const remote = remoteIssues(repo);
  const refs = () =>
    new Map<string, IssueRef>(
      [...remote].map(([k, r]) => [k, { number: r.number, url: r.html_url }]),
    );

  // Pass 1: make sure every key has an issue.
  for (const issue of m.issues) {
    if (remote.has(issue.key)) continue;
    console.log(`issue create: ${issueTitle(issue)}`);
    if (dry) continue;
    const milestone = issue.milestone ? milestones.get(issue.milestone) : undefined;
    try {
      const created = await write(`issue:${issue.key}`, () =>
        rest("POST", `repos/${repo}/issues`, {
          title: issueTitle(issue),
          body: renderBody(m, issue, refs()),
          ...(milestone ? { milestone } : {}),
        }),
      );
      remote.set(issue.key, created as RemoteIssue);
    } catch (error) {
      // Outcome unknown (timeout/5xx): reconcile by marker before anyone retries.
      const again = remoteIssues(repo).get(issue.key);
      if (!again) throw error;
      journal({ reconciled: `issue:${issue.key}`, number: again.number });
      remote.set(issue.key, again);
    }
  }

  // Pass 2: bodies now reference real URLs; update title/body/milestone drift.
  for (const issue of m.issues) {
    const r = remote.get(issue.key);
    if (!r) continue;
    const want = {
      title: issueTitle(issue),
      body: renderBody(m, issue, refs()),
      milestone: issue.milestone ? (milestones.get(issue.milestone) ?? null) : null,
    };
    if (
      r.title === want.title &&
      r.body === want.body &&
      (r.milestone?.number ?? null) === want.milestone
    ) {
      continue;
    }
    console.log(`issue update: #${String(r.number)} ${issue.key}`);
    if (!dry) {
      const updated = await write(`issue-update:${issue.key}`, () =>
        rest("PATCH", `repos/${repo}/issues/${String(r.number)}`, want),
      );
      remote.set(issue.key, updated as RemoteIssue);
    }
  }
  return remote;
}

async function linkRelationships(
  m: Manifest,
  repo: string,
  remote: ReadonlyMap<string, RemoteIssue>,
  dry: boolean,
): Promise<void> {
  const get = (key: string) => {
    const r = remote.get(key);
    if (!r) throw new Error(`${key} has no remote issue`);
    return r;
  };
  for (const epic of m.issues.filter((i) => i.type === "epic")) {
    const parent = get(epic.key);
    const have = new Set(
      restAll(`repos/${repo}/issues/${String(parent.number)}/sub_issues?per_page=100`).map((s) =>
        Number(s.id),
      ),
    );
    for (const child of m.issues.filter((i) => i.parent === epic.key)) {
      const c = get(child.key);
      if (have.has(c.id)) continue;
      console.log(`sub-issue add: ${epic.key} <- ${child.key}`);
      if (!dry) {
        await write(`sub-issue:${epic.key}:${child.key}`, () =>
          rest("POST", `repos/${repo}/issues/${String(parent.number)}/sub_issues`, {
            sub_issue_id: c.id,
          }),
        );
      }
    }
  }
  for (const issue of m.issues) {
    const deps = issue.blocked_by ?? [];
    if (deps.length === 0) continue;
    const r = get(issue.key);
    const have = new Set(
      restAll(`repos/${repo}/issues/${String(r.number)}/dependencies/blocked_by?per_page=100`).map(
        (d) => Number(d.id),
      ),
    );
    for (const dep of deps) {
      const d = get(dep);
      if (have.has(d.id)) continue;
      console.log(`dependency add: ${issue.key} blocked by ${dep}`);
      if (!dry) {
        await write(`blocked-by:${issue.key}:${dep}`, () =>
          rest("POST", `repos/${repo}/issues/${String(r.number)}/dependencies/blocked_by`, {
            issue_id: d.id,
          }),
        );
      }
    }
  }
}

// ── GitHub Project (v2) ──────────────────────────────────────────────────────
interface ProjectField {
  id: string;
  name: string;
  dataType: string;
  options?: { id: string; name: string }[];
}
interface ProjectInfo {
  id: string;
  number: number;
  url: string;
  fields: ProjectField[];
}

const PROJECT_FIELDS = `fields(first: 50) { nodes {
  ... on ProjectV2FieldCommon { id name dataType }
  ... on ProjectV2SingleSelectField { options { id name } } } }`;

function findProject(owner: string, title: string): ProjectInfo | undefined {
  const data = graphql(
    `query($owner: String!) { organization(login: $owner) { projectsV2(first: 100) { nodes {
      id number url title closed ${PROJECT_FIELDS} } } } }`,
    { owner },
  ) as {
    organization: {
      projectsV2: { nodes: (ProjectInfo & { title: string; fields: { nodes: ProjectField[] } })[] };
    };
  };
  const matches = data.organization.projectsV2.nodes.filter((p) => p.title === title);
  if (matches.length > 1)
    throw new Error(`more than one Project titled "${title}"; resolve manually`);
  const p = matches[0];
  return p && { id: p.id, number: p.number, url: p.url, fields: p.fields.nodes };
}

async function ensureProject(
  m: Manifest,
  repoNodeId: string,
  dry: boolean,
): Promise<ProjectInfo | undefined> {
  let project = findProject(m.project.owner, m.project.title);
  if (!project) {
    console.log(`project create: ${m.project.title}`);
    if (dry) return undefined;
    const owner = graphql(
      `
        query ($o: String!) {
          organization(login: $o) {
            id
          }
        }
      `,
      { o: m.project.owner },
    ) as {
      organization: { id: string };
    };
    await write("project", () =>
      graphql(
        `
          mutation ($owner: ID!, $title: String!, $repo: ID!) {
            createProjectV2(input: { ownerId: $owner, title: $title, repositoryId: $repo }) {
              projectV2 {
                id
              }
            }
          }
        `,
        { owner: owner.organization.id, title: m.project.title, repo: repoNodeId },
      ),
    );
    project = findProject(m.project.owner, m.project.title);
    if (!project) throw new Error("Project not found after creation");
  } else console.log(`project reuse: ${project.url}`);

  for (const field of m.fields) {
    const have = project.fields.find((f) => f.name === field.name);
    if (field.text) {
      if (have) continue;
      console.log(`field create: ${field.name} (text)`);
      if (!dry) {
        await write(`field:${field.name}`, () =>
          graphql(
            `
              mutation ($p: ID!, $n: String!) {
                createProjectV2Field(input: { projectId: $p, name: $n, dataType: TEXT }) {
                  clientMutationId
                }
              }
            `,
            { p: project.id, n: field.name },
          ),
        );
      }
      continue;
    }
    const want = field.options ?? [];
    const options = want.map((name) => ({ name, color: "GRAY", description: "" }));
    if (!have) {
      console.log(`field create: ${field.name} [${want.join(", ")}]`);
      if (!dry) {
        await write(`field:${field.name}`, () =>
          graphql(
            `
              mutation ($p: ID!, $n: String!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
                createProjectV2Field(
                  input: {
                    projectId: $p
                    name: $n
                    dataType: SINGLE_SELECT
                    singleSelectOptions: $o
                  }
                ) {
                  clientMutationId
                }
              }
            `,
            { p: project.id, n: field.name, o: options },
          ),
        );
      }
    } else if (JSON.stringify(have.options?.map((o) => o.name)) !== JSON.stringify(want)) {
      // Replacing options drops values that used removed options; only safe at bootstrap.
      console.log(`field options update: ${field.name} [${want.join(", ")}]`);
      if (!dry) {
        await write(`field-options:${field.name}`, () =>
          graphql(
            `
              mutation ($f: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
                updateProjectV2Field(input: { fieldId: $f, singleSelectOptions: $o }) {
                  clientMutationId
                }
              }
            `,
            { f: have.id, o: options },
          ),
        );
      }
    }
  }
  return findProject(m.project.owner, m.project.title);
}

interface ItemState {
  id: string;
  values: Map<string, string>;
}

function projectItems(projectId: string): Map<string, ItemState> {
  const items = new Map<string, ItemState>();
  let cursor: string | null = null;
  for (;;) {
    const data = graphql(
      `
        query ($p: ID!, $after: String) {
          node(id: $p) {
            ... on ProjectV2 {
              items(first: 100, after: $after) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  content {
                    ... on Issue {
                      id
                    }
                  }
                  fieldValues(first: 30) {
                    nodes {
                      ... on ProjectV2ItemFieldTextValue {
                        text
                        field {
                          ... on ProjectV2FieldCommon {
                            name
                          }
                        }
                      }
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field {
                          ... on ProjectV2FieldCommon {
                            name
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { p: projectId, after: cursor },
    ) as {
      node: {
        items: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          nodes: {
            id: string;
            content: { id?: string } | null;
            fieldValues: { nodes: { text?: string; name?: string; field?: { name: string } }[] };
          }[];
        };
      };
    };
    for (const n of data.node.items.nodes) {
      if (!n.content?.id) continue;
      const values = new Map<string, string>();
      for (const v of n.fieldValues.nodes) {
        if (v.field) values.set(v.field.name, v.text ?? v.name ?? "");
      }
      items.set(n.content.id, { id: n.id, values });
    }
    if (!data.node.items.pageInfo.hasNextPage) return items;
    cursor = data.node.items.pageInfo.endCursor;
  }
}

function desiredValues(issue: ManifestIssue): Map<string, string> {
  const v = new Map<string, string>([
    ["Plan Key", issue.key],
    ["Work Type", WORK_TYPE[issue.type]],
    ["Area", issue.area],
  ]);
  if (issue.priority) v.set("Priority", issue.priority);
  if (issue.role) v.set("Role", issue.role);
  if (issue.workflow) v.set("Workflow", issue.workflow);
  return v;
}

async function syncItems(
  m: Manifest,
  project: ProjectInfo,
  remote: ReadonlyMap<string, RemoteIssue>,
  dry: boolean,
): Promise<void> {
  const items = projectItems(project.id);
  const field = (name: string) => {
    const f = project.fields.find((x) => x.name === name);
    if (!f) throw new Error(`Project field ${name} missing`);
    return f;
  };
  for (const issue of m.issues) {
    const r = remote.get(issue.key);
    if (!r) continue;
    let item = items.get(r.node_id);
    if (!item) {
      console.log(`project item add: ${issue.key}`);
      if (dry) continue;
      const added = (await write(`item:${issue.key}`, () =>
        graphql(
          `
            mutation ($p: ID!, $c: ID!) {
              addProjectV2ItemById(input: { projectId: $p, contentId: $c }) {
                item {
                  id
                }
              }
            }
          `,
          { p: project.id, c: r.node_id },
        ),
      )) as { addProjectV2ItemById: { item: { id: string } } };
      item = { id: added.addProjectV2ItemById.item.id, values: new Map() };
    }
    const want = desiredValues(issue);
    // Status is only initialised; later moves (Ready, In Progress...) are never reset.
    if (!item.values.has("Status")) want.set("Status", "Backlog");
    const changes = [...want].filter(([name, value]) => item.values.get(name) !== value);
    if (changes.length === 0) continue;
    console.log(
      `project fields set: ${issue.key} ${changes.map(([n, v]) => `${n}=${v}`).join(", ")}`,
    );
    if (dry) continue;
    const parts = changes.map(([name, value], i) => {
      const f = field(name);
      const val =
        f.dataType === "TEXT"
          ? `{ text: ${JSON.stringify(value)} }`
          : `{ singleSelectOptionId: ${JSON.stringify(
              f.options?.find((o) => o.name === value)?.id ??
                (() => {
                  throw new Error(`option ${value} missing on ${name}`);
                })(),
            )} }`;
      return `f${String(i)}: updateProjectV2ItemFieldValue(input: { projectId: "${project.id}", itemId: "${item.id}", fieldId: "${f.id}", value: ${val} }) { clientMutationId }`;
    });
    await write(`fields:${issue.key}`, () => graphql(`mutation { ${parts.join("\n")} }`));
  }
}

// Views: the API covers name, layout, filter and visible fields. The default "View 1" of a
// fresh Project is renamed into the first view instead of leaving an empty extra view.
async function ensureViews(m: Manifest, project: ProjectInfo, dry: boolean): Promise<void> {
  type View = { id: string; name: string; layout: string; filter: string | null; fields: string[] };
  const read = (): View[] =>
    (
      graphql(
        `
          query ($p: ID!) {
            node(id: $p) {
              ... on ProjectV2 {
                views(first: 50) {
                  nodes {
                    id
                    name
                    layout
                    filter
                    fields(first: 50) {
                      nodes {
                        ... on ProjectV2FieldCommon {
                          name
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        { p: project.id },
      ) as {
        node: {
          views: { nodes: (Omit<View, "fields"> & { fields: { nodes: { name: string }[] } })[] };
        };
      }
    ).node.views.nodes.map((v) => ({ ...v, fields: v.fields.nodes.map((f) => f.name) }));
  let views = read();
  for (const want of m.views) {
    const layout = want.layout === "board" ? "BOARD_LAYOUT" : "TABLE_LAYOUT";
    const fieldIds = want.fields.map((name) => {
      const f = project.fields.find((x) => x.name === name);
      if (!f) throw new Error(`view ${want.name}: unknown field ${name}`);
      return f.id;
    });
    let view = views.find((v) => v.name === want.name);
    if (!view) {
      const spare = m.views.some((v) => v.name === "View 1")
        ? undefined
        : views.find((v) => v.name === "View 1");
      console.log(spare ? `view rename: View 1 -> ${want.name}` : `view create: ${want.name}`);
      if (dry) {
        views = views.filter((v) => v !== spare);
        continue;
      }
      if (!spare) {
        await write(`view:${want.name}`, () =>
          graphql(
            `
              mutation ($p: ID!, $n: String!, $l: ProjectV2ViewLayout!) {
                createProjectV2View(input: { projectId: $p, name: $n, layout: $l }) {
                  clientMutationId
                }
              }
            `,
            { p: project.id, n: want.name, l: layout },
          ),
        );
        views = read();
        view = views.find((v) => v.name === want.name);
      } else view = { ...spare, name: "" };
      if (!view) throw new Error(`view ${want.name} not found after creation`);
    }
    if (
      view.name === want.name &&
      view.layout === layout &&
      (view.filter ?? "") === want.filter &&
      // The API returns visible fields in Project field order, not request order.
      JSON.stringify([...view.fields].sort()) === JSON.stringify([...want.fields].sort())
    ) {
      continue;
    }
    console.log(`view update: ${want.name}`);
    if (dry) continue;
    const id = view.id;
    await write(`view-update:${want.name}`, () =>
      graphql(
        `
          mutation ($v: ID!, $n: String!, $l: ProjectV2ViewLayout!, $f: String!, $ids: [ID!]) {
            updateProjectV2View(
              input: {
                viewId: $v
                name: $n
                layout: $l
                filter: $f
                configuration: { visibleFieldIds: $ids }
              }
            ) {
              clientMutationId
            }
          }
        `,
        { v: id, n: want.name, l: layout, f: want.filter, ids: fieldIds },
      ),
    );
    views = read();
  }
}

// ── entry ────────────────────────────────────────────────────────────────────
async function main(command: string | undefined): Promise<void> {
  const m = load();
  const epics = m.issues.filter((i) => i.type === "epic").length;
  if (command === "validate") {
    console.log(
      `${MANIFEST}: ok — ${String(m.milestones.length)} milestones, ${String(epics)} epics, ${String(m.issues.length - epics)} sub-issues, consistent with ${PLAN}`,
    );
    return;
  }
  if (command !== "plan" && command !== "apply") {
    console.error("usage: node tools/github-bootstrap/main.ts validate|plan|apply");
    process.exit(2);
  }
  const dry = command === "plan";
  mkdirSync(OUT, { recursive: true });
  const repo = `${m.project.owner}/${m.project.repository}`;
  const repoNodeId = String((rest("GET", `repos/${repo}`) as Json).node_id);
  journal({ run: command, repo });

  const milestones = await upsertMilestones(m, repo, dry);
  const remote = await upsertIssues(m, repo, milestones, dry);
  if (!dry || remote.size === m.issues.length) await linkRelationships(m, repo, remote, dry);
  const project = await ensureProject(m, repoNodeId, dry);
  if (project) {
    await syncItems(m, project, remote, dry);
    await ensureViews(m, project, dry);
  }

  const mapping = {
    repository: repo,
    project: project ? { id: project.id, number: project.number, url: project.url } : null,
    milestones: Object.fromEntries(milestones),
    fields: project?.fields.map((f) => ({ name: f.name, id: f.id, options: f.options })) ?? [],
    issues: Object.fromEntries(
      [...remote].map(([k, r]) => [
        k,
        { number: r.number, id: r.id, node_id: r.node_id, url: r.html_url },
      ]),
    ),
  };
  writeFileSync(join(OUT, "mapping.json"), `${JSON.stringify(mapping, null, 2)}\n`);
  console.log(`${command}: done; mapping in ${OUT}/mapping.json`);
}

await main(process.argv[2]);
