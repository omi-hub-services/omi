// I/O for Issue intake and parent changes; all validation and key decisions stay in issue-spec.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { marker, MARKER_PATTERN } from "../github-bootstrap/manifest.ts";
import { OWNER, PROJECT_NUMBER, REPO_SLUG } from "./coordinator-settings.ts";
import { graphql } from "./github-reads.ts";
import {
  issueSpecContent,
  nextPlanKey,
  nextEpicPlanKey,
  specProjectValues,
  parseIssueSpec,
  validateSpecOptions,
  type ProjectField,
} from "./issue-spec.ts";
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  optObject,
  optString,
  parseJson,
} from "./json-shape.ts";
import { runChecked, type Runner } from "./process-runner.ts";

export const EPIC_SUB_ISSUE_LIMIT = 100;

export async function epicCapacityReason(run: Runner, number: number): Promise<string | null> {
  const pages = asArray(
    parseJson(
      await runChecked(run, {
        file: "gh",
        args: [
          "api",
          `repos/${REPO_SLUG}/issues/${String(number)}/sub_issues?per_page=100`,
          "--paginate",
          "--slurp",
        ],
      }),
      "sub-issues",
    ),
    "sub-issue pages",
  );
  const count = pages.flatMap((page) => asArray(page, "sub-issue page")).length;
  return count >= EPIC_SUB_ISSUE_LIMIT
    ? `EPIC_SUB_ISSUE_LIMIT: Epic #${String(number)} has ${String(count)} sub-issues (limit ${String(EPIC_SUB_ISSUE_LIMIT)})`
    : null;
}

export async function createIssue(
  run: Runner,
  file: string,
  dryRun: boolean,
  epicMode = false,
): Promise<number> {
  const refuse = (reason: string) => {
    console.error(`${epicMode ? "new-epic" : "new-issue"}: refused: ${reason}`);
    return 1;
  };
  const source = readFileSync(file, "utf8");
  const parsed = parseIssueSpec(source, epicMode);
  if (parsed.kind === "refuse") return refuse(parsed.reason);
  const spec = parsed.spec;
  const gh = async (...args: string[]) => runChecked(run, { file: "gh", args });
  const data = await graphql(
    run,
    `
      query ($owner: String!, $project: Int!) {
        organization(login: $owner) {
          projectV2(number: $project) {
            id
            fields(first: 100) {
              nodes {
                ... on ProjectV2Field {
                  id
                  name
                  dataType
                }
                ... on ProjectV2IterationField {
                  id
                  name
                }
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      }
    `,
    { owner: OWNER, project: PROJECT_NUMBER },
  );
  const project = asObject(asObject(data.organization, "organization").projectV2, "project");
  const projectId = asString(project.id, "project.id");
  const connection = asObject(project.fields, "project.fields");
  if (asObject(connection.pageInfo, "fields.pageInfo").hasNextPage !== false)
    return refuse("Project fields truncated");
  const rawFields = asArray(connection.nodes, "fields.nodes").map((f) => asObject(f, "field"));
  const fields: ProjectField[] = rawFields.map((f) => ({
    id: asString(f.id, "field.id"),
    name: asString(f.name, "field.name"),
    options:
      f.options === undefined
        ? []
        : asArray(f.options, "field.options").map((raw) => {
            const o = asObject(raw, "option");
            return { id: asString(o.id, "option.id"), name: asString(o.name, "option.name") };
          }),
  }));
  const errors = validateSpecOptions(spec, fields);
  const keyField = rawFields.find((f) => f.name === "Plan Key" && f.dataType === "TEXT");
  if (!keyField) errors.push("Project needs a Plan Key text field");
  if (errors.length > 0) return refuse(errors.join("; "));
  // REST pagination includes closed Issues; pull requests do not allocate task keys.
  const pages = asArray(
    parseJson(
      await gh("api", `repos/${REPO_SLUG}/issues?state=all&per_page=100`, "--paginate", "--slurp"),
      "issues",
    ),
    "issue pages",
  );
  const issues = pages
    .flatMap((p) => asArray(p, "issue page"))
    .map((i) => asObject(i, "issue"))
    .filter((i) => i.pull_request === undefined);
  const requested = MARKER_PATTERN.exec(spec.body)?.[1];
  const existing = requested
    ? issues.find(
        (i) => MARKER_PATTERN.exec(asString(i.body ?? "", "issue.body"))?.[1] === requested,
      )
    : undefined;
  if (existing) {
    console.log(
      `${epicMode ? "new-epic" : "new-issue"}: done: ${requested ?? ""} exists on #${String(asNumber(existing.number, "issue.number"))}`,
    );
    return 0;
  }
  const keys = issues.flatMap((i) => [
    MARKER_PATTERN.exec(asString(i.body ?? "", "issue.body"))?.[1] ?? null,
    /^\[((?:OMI-\d{3}|EP-\d{2,}))\]/.exec(asString(i.title, "issue.title"))?.[1] ?? null,
  ]);
  // Also reserve Project-only Plan Keys (including items with legacy/missing markers).
  let after: string | null = null;
  do {
    const page = await graphql(
      run,
      `
        query ($owner: String!, $project: Int!, $after: String) {
          organization(login: $owner) {
            projectV2(number: $project) {
              items(first: 100, after: $after) {
                nodes {
                  planKey: fieldValueByName(name: "Plan Key") {
                    ... on ProjectV2ItemFieldTextValue {
                      text
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      { owner: OWNER, project: PROJECT_NUMBER, after },
    );
    const items = asObject(
      asObject(asObject(page.organization, "organization").projectV2, "project").items,
      "items",
    );
    for (const raw of asArray(items.nodes, "items.nodes")) {
      const value = optObject(asObject(raw, "item").planKey, "item.planKey");
      keys.push(optString(value?.text, "planKey.text"));
    }
    const info = asObject(items.pageInfo, "items.pageInfo");
    after = asBoolean(info.hasNextPage, "hasNextPage")
      ? asString(info.endCursor, "endCursor")
      : null;
  } while (after !== null);
  const key = requested ?? (epicMode ? nextEpicPlanKey(keys) : nextPlanKey(keys));
  if (requested && keys.includes(requested))
    return refuse(`${requested} is already allocated without a matching marker`);
  const content = issueSpecContent(spec, key);
  // Resolve every reference before the first write (no half-created Issue on a bad spec).
  const references = new Map<number, number>();
  for (const number of new Set("epic" in spec ? [spec.epic, ...spec.blockedBy] : [])) {
    const ref = issues.find((i) => i.number === number);
    if (!ref) return refuse(`Issue #${String(number)} not found`);
    references.set(number, asNumber(ref.id, "issue.id"));
  }
  if ("epic" in spec) {
    const epic = issues.find((i) => i.number === spec.epic);
    if (
      !epic ||
      !MARKER_PATTERN.exec(asString(epic.body ?? "", "epic.body"))?.[1]?.startsWith("EP-")
    )
      return refuse(`Issue #${String(spec.epic)} is not an Epic with a Plan Key marker`);
    const capacity = await epicCapacityReason(run, spec.epic);
    if (capacity) return refuse(capacity);
  }
  const milestones = asArray(
    parseJson(
      await gh(
        "api",
        `repos/${REPO_SLUG}/milestones?state=all&per_page=100`,
        "--paginate",
        "--slurp",
      ),
      "milestones",
    ),
    "milestone pages",
  )
    .flatMap((p) => asArray(p, "milestone page"))
    .map((m) => asObject(m, "milestone"));
  const milestone = milestones.find((m) => m.title === spec.milestone);
  if (!milestone) return refuse(`unknown milestone "${spec.milestone}"`);
  const values = { ...specProjectValues(spec), "Plan Key": key };
  console.log(
    `${epicMode ? "new-epic" : "new-issue"}: ${JSON.stringify({ planKey: key, ...content, fields: values, milestone: spec.milestone, ...("epic" in spec ? { epic: spec.epic, blockedBy: spec.blockedBy } : {}) })}`,
  );
  if (dryRun) {
    console.log(
      `${epicMode ? "new-epic" : "new-issue"}: would create Issue and set Project fields (no writes)`,
    );
    return 0;
  }
  // The durable marker is saved before creating remotely, so retries cannot allocate a new key.
  if (!requested) writeFileSync(file, `${source.trimEnd()}\n\n${marker(key)}\n`);
  const created = asObject(
    parseJson(
      await runChecked(run, {
        file: "gh",
        args: ["api", `repos/${REPO_SLUG}/issues`, "--method", "POST", "--input", "-"],
        input: JSON.stringify({
          ...content,
          milestone: asNumber(milestone.number, "milestone.number"),
        }),
      }),
      "created issue",
    ),
    "created issue",
  );
  const number = asNumber(created.number, "created.number");
  const id = asNumber(created.id, "created.id");
  const nodeId = asString(created.node_id, "created.node_id");
  const added = await graphql(
    run,
    `
      mutation ($project: ID!, $issue: ID!) {
        addProjectV2ItemById(input: { projectId: $project, contentId: $issue }) {
          item {
            id
          }
        }
      }
    `,
    { project: projectId, issue: nodeId },
  );
  const itemId = asString(
    asObject(asObject(added.addProjectV2ItemById, "added").item, "item").id,
    "item.id",
  );
  for (const [name, value] of Object.entries(values)) {
    const field = fields.find((f) => f.name === name);
    if (!field) throw new Error(`Project field ${name} disappeared`);
    const option = field.options.find((o) => o.name === value);
    await gh(
      "project",
      "item-edit",
      "--id",
      itemId,
      "--project-id",
      projectId,
      "--field-id",
      field.id,
      ...(name === "Plan Key"
        ? ["--text", value]
        : ["--single-select-option-id", asString(option?.id, "option.id")]),
    );
  }
  const post = async (path: string, body: Readonly<Record<string, number>>) =>
    runChecked(run, {
      file: "gh",
      args: ["api", `repos/${REPO_SLUG}/${path}`, "--method", "POST", "--input", "-"],
      input: JSON.stringify(body),
    });
  if ("epic" in spec) {
    await post(`issues/${String(spec.epic)}/sub_issues`, { sub_issue_id: id });
    for (const dep of new Set(spec.blockedBy)) {
      await post(`issues/${String(number)}/dependencies/blocked_by`, {
        issue_id: asNumber(references.get(dep), "dependency.id"),
      });
    }
  }
  console.log(`${epicMode ? "new-epic" : "new-issue"}: ok: #${String(number)} ${key}`);
  return 0;
}

export async function setIssueEpic(
  run: Runner,
  number: number,
  epic: number,
  dryRun: boolean,
): Promise<number> {
  const refuse = (reason: string) => {
    console.error(`set-epic: refused: ${reason}`);
    return 1;
  };
  if (number === epic) return refuse("an Issue cannot be its own Epic");
  const get = async (n: number) =>
    asObject(
      parseJson(
        await runChecked(run, {
          file: "gh",
          args: ["api", `repos/${REPO_SLUG}/issues/${String(n)}`],
        }),
        "issue",
      ),
      "issue",
    );
  const issue = await get(number);
  const target = await get(epic);
  if (!/^EP-\d{2,}$/.test(MARKER_PATTERN.exec(asString(target.body ?? "", "epic.body"))?.[1] ?? ""))
    return refuse(`Issue #${String(epic)} is not an Epic with a Plan Key marker`);
  const parent = await run({
    file: "gh",
    args: ["api", `repos/${REPO_SLUG}/issues/${String(number)}/parent`],
  });
  if (parent.code === 0) {
    const current = asObject(parseJson(parent.stdout, "parent"), "parent");
    if (asNumber(current.id, "parent.id") === asNumber(target.id, "epic.id")) {
      console.log(`set-epic: done: #${String(number)} already belongs to #${String(epic)}`);
      return 0;
    }
  } else if (!parent.stderr.includes("(HTTP 404)"))
    throw new Error(`Cannot read Issue parent: ${parent.stderr}`);
  const capacity = await epicCapacityReason(run, epic);
  if (capacity) return refuse(capacity);
  const id = asNumber(issue.id, "issue.id");
  if (dryRun) console.log(`set-epic: would move #${String(number)} to #${String(epic)}`);
  else
    await runChecked(run, {
      file: "gh",
      args: [
        "api",
        `repos/${REPO_SLUG}/issues/${String(epic)}/sub_issues`,
        "--method",
        "POST",
        "--input",
        "-",
      ],
      input: JSON.stringify({ sub_issue_id: id, replace_parent: true }),
    });
  return 0;
}
