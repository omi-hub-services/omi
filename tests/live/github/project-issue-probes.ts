// OMI-006 — setup-phase probes for Project v2 fields/items and Issue relations (sub-issues,
// native dependencies, close). Run by the author actor against the sandbox only.
import type { CapabilityId, Verdict } from "./probe-model.ts";
import {
  type FieldKey,
  type IssueKey,
  type IssueRef,
  numbersAt,
  parseJsonOutput,
  pick,
  pickArray,
  pickNumber,
  pickString,
  type ProbeSession,
} from "./probe-session.ts";

const GRAPHQL = ["api", "graphql", "--input", "-"] as const;

const PROBE_FIELDS: readonly { key: FieldKey; name: string; dataType: string }[] = [
  { key: "select", name: "Probe Select", dataType: "SINGLE_SELECT" },
  { key: "text", name: "Probe Text", dataType: "TEXT" },
  { key: "number", name: "Probe Number", dataType: "NUMBER" },
  { key: "date", name: "Probe Date", dataType: "DATE" },
];
const SELECT_OPTIONS = ["Alpha", "Beta"];

const PROJECT_FIELDS_QUERY = `query($owner: String!, $number: Int!) {
  organization(login: $owner) {
    projectV2(number: $number) {
      id title closed
      fields(first: 100) {
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name } }
        }
      }
    }
  }
}`;

const ITEM_VALUES_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2Item {
      id
      fieldValues(first: 50) {
        nodes {
          __typename
          ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } }
          ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id } } }
          ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id } } }
          ... on ProjectV2ItemFieldSingleSelectValue { optionId name field { ... on ProjectV2FieldCommon { id } } }
        }
      }
    }
  }
}`;

const SET_SINGLE_SELECT_MUTATION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option }
  }) { projectV2Item { id } }
}`;

const HIERARCHY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      parent { number }
      subIssues(first: 20) { nodes { number } }
    }
  }
}`;

const DEPENDENCY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      blockedBy(first: 20) { nodes { number } }
      blocking(first: 20) { nodes { number } }
    }
  }
}`;

const ADD_BLOCKED_BY_MUTATION = `mutation($issue: ID!, $blocking: ID!) {
  addBlockedBy(input: { issueId: $issue, blockingIssueId: $blocking }) { issue { number } }
}`;

interface FieldInfo {
  id: string;
  name: string;
  dataType: string;
  options: { id: string; name: string }[];
}

function readFields(stdout: string): FieldInfo[] {
  const data = parseJsonOutput(stdout);
  return pickArray(data, "data.organization.projectV2.fields.nodes").flatMap((node) => {
    const id = pickString(node, "id");
    const name = pickString(node, "name");
    if (id === undefined || name === undefined) return [];
    const options = pickArray(node, "options").flatMap((option) => {
      const optionId = pickString(option, "id");
      const optionName = pickString(option, "name");
      return optionId === undefined || optionName === undefined
        ? []
        : [{ id: optionId, name: optionName }];
    });
    return [{ id, name, dataType: pickString(node, "dataType") ?? "", options }];
  });
}

function expectTrue(condition: boolean, okNote: string, badNote: string): Verdict {
  return condition ? { result: "supported", note: okNote } : { result: "partial", note: badNote };
}

export async function probeProject(session: ProbeSession): Promise<void> {
  const { state } = session;
  const variables = { owner: state.projectOwner, number: state.projectNumber };

  const read = await session.step({
    id: "project.read.graphql",
    capability: "project.read-fields",
    api: "GraphQL organization.projectV2.fields",
    args: GRAPHQL,
    body: { query: PROJECT_FIELDS_QUERY, variables },
    expect: "success",
    verify: (stdout) => {
      const id = pickString(parseJsonOutput(stdout), "data.organization.projectV2.id");
      return expectTrue(id !== undefined, "", "Project id missing in response");
    },
    observe: (stdout) => {
      const data = parseJsonOutput(stdout);
      return {
        projectId: pickString(data, "data.organization.projectV2.id") ?? null,
        title: pickString(data, "data.organization.projectV2.title") ?? null,
        fieldCount: readFields(stdout).length,
      };
    },
  });
  await session.step({
    id: "project.read.cli",
    capability: "project.read-fields",
    api: "gh project field-list",
    args: [
      "project",
      "field-list",
      String(state.projectNumber),
      "--owner",
      state.projectOwner,
      "--format",
      "json",
    ],
    expect: "success",
    observe: (stdout) => ({ fieldCount: pickArray(parseJsonOutput(stdout), "fields").length }),
  });
  const projectId = pickString(parseJsonOutput(read.stdout), "data.organization.projectV2.id");
  if (!read.ok || projectId === undefined) {
    session.skip("project.all", "project.read-fields", "-", "Project could not be read");
    return;
  }
  state.projectId = projectId;
  let fields = readFields(read.stdout);
  const status = fields.find((f) => f.name === "Status" && f.dataType === "SINGLE_SELECT");
  const statusOption = status?.options[0];
  if (status !== undefined && statusOption !== undefined) {
    state.statusField = { id: status.id, name: status.name, optionId: statusOption.id };
  }

  // Create the probe fields that do not exist yet (re-runs reuse them).
  for (const spec of PROBE_FIELDS) {
    const existing = fields.find((f) => f.name === spec.name);
    if (existing !== undefined) {
      session.observe({
        id: `project.field.${spec.key}.exists`,
        capability: "project.create-field",
        api: "gh project field-create",
        command: "(field already present from an earlier run)",
        result: "supported",
        detail: `field "${spec.name}" reused`,
        observed: { fieldId: existing.id },
      });
      continue;
    }
    const args = [
      "project",
      "field-create",
      String(state.projectNumber),
      "--owner",
      state.projectOwner,
      "--name",
      spec.name,
      "--data-type",
      spec.dataType,
      "--format",
      "json",
    ];
    if (spec.dataType === "SINGLE_SELECT")
      args.push("--single-select-options", SELECT_OPTIONS.join(","));
    const created = await session.step({
      id: `project.field.${spec.key}.create`,
      capability: "project.create-field",
      api: "gh project field-create",
      args,
      expect: "success",
      observe: (stdout) => ({ fieldId: pickString(parseJsonOutput(stdout), "id") ?? null }),
    });
    const createdId = pickString(parseJsonOutput(created.stdout), "id");
    if (createdId !== undefined) state.createdFieldIds.push(createdId);
  }
  session.saveState();
  const reread = await session.gh(GRAPHQL, { query: PROJECT_FIELDS_QUERY, variables });
  if (reread.code === 0) fields = readFields(reread.stdout);
  for (const spec of PROBE_FIELDS) {
    const field = fields.find((f) => f.name === spec.name);
    if (field === undefined) continue;
    const option = field.options.find((o) => o.name === SELECT_OPTIONS[1]) ?? field.options[0];
    state.fields[spec.key] = { id: field.id, name: field.name, optionId: option?.id ?? null };
  }
  session.saveState();
}

async function createIssue(
  session: ProbeSession,
  key: IssueKey,
  title: string,
): Promise<IssueRef | undefined> {
  const created = await session.step({
    id: `issue.create.${key}`,
    capability: "issue.create",
    api: "REST POST /repos/{r}/issues",
    args: ["api", "-X", "POST", `repos/${session.repo}/issues`, "--input", "-"],
    body: {
      title: `[omi-probe ${session.state.runId}] ${title}`,
      body: `Created by the OMI-006 capability probe (run ${session.state.runId}). Safe to delete.`,
    },
    expect: "success",
    observe: (stdout) => ({ number: pickNumber(parseJsonOutput(stdout), "number") ?? null }),
  });
  const data = parseJsonOutput(created.stdout);
  const number = pickNumber(data, "number");
  const id = pickNumber(data, "id");
  const nodeId = pickString(data, "node_id");
  const url = pickString(data, "html_url");
  if (
    !created.ok ||
    number === undefined ||
    id === undefined ||
    nodeId === undefined ||
    url === undefined
  ) {
    return undefined;
  }
  const ref = { number, id, nodeId, url };
  session.state.issues[key] = ref;
  session.saveState();
  return ref;
}

export async function probeProjectItem(session: ProbeSession, issue: IssueRef): Promise<void> {
  const { state } = session;
  if (state.projectId === null) {
    session.skip("project.item", "project.add-item", "gh project item-add", "Project not read");
    return;
  }
  const added = await session.step({
    id: "project.item.add",
    capability: "project.add-item",
    api: "gh project item-add",
    args: [
      "project",
      "item-add",
      String(state.projectNumber),
      "--owner",
      state.projectOwner,
      "--url",
      issue.url,
      "--format",
      "json",
    ],
    expect: "success",
  });
  const itemId = pickString(parseJsonOutput(added.stdout), "id");
  if (!added.ok || itemId === undefined) {
    session.skip("project.values", "project.value.text", "-", "item could not be added");
    return;
  }
  state.itemIds.push(itemId);
  session.saveState();

  const { select, text, number, date } = state.fields;
  const projectArgs = ["project", "item-edit", "--id", itemId, "--project-id", state.projectId];
  const expected = new Map<string, { capability: CapabilityId; key: string; value: string }>();
  const write = async (
    key: string,
    capability: CapabilityId,
    fieldId: string,
    flag: string,
    value: string,
  ): Promise<void> => {
    const result = await session.step({
      id: `project.value.${key}.write`,
      capability,
      api: `gh project item-edit ${flag}`,
      args: [...projectArgs, "--field-id", fieldId, flag, value],
      expect: "success",
    });
    if (result.ok) expected.set(fieldId, { capability, key, value });
  };
  if (select?.optionId != null) {
    await write(
      "single-select",
      "project.value.single-select",
      select.id,
      "--single-select-option-id",
      select.optionId,
    );
  }
  if (text !== undefined)
    await write("text", "project.value.text", text.id, "--text", `probe ${state.runId}`);
  if (number !== undefined)
    await write("number", "project.value.number", number.id, "--number", "42.5");
  if (date !== undefined)
    await write("date", "project.value.date", date.id, "--date", "2026-11-10");
  const statusField = state.statusField;
  if (statusField?.optionId != null) {
    const result = await session.step({
      id: "project.value.status.write-graphql",
      capability: "project.value.single-select",
      api: "GraphQL updateProjectV2ItemFieldValue (built-in Status)",
      args: GRAPHQL,
      body: {
        query: SET_SINGLE_SELECT_MUTATION,
        variables: {
          project: state.projectId,
          item: itemId,
          field: statusField.id,
          option: statusField.optionId,
        },
      },
      expect: "success",
    });
    if (result.ok) {
      expected.set(statusField.id, {
        capability: "project.value.single-select",
        key: "status",
        value: statusField.optionId,
      });
    }
  }

  const readback = await session.step({
    id: "project.value.readback",
    capability: "project.value.text",
    api: "GraphQL node(ProjectV2Item).fieldValues",
    args: GRAPHQL,
    body: { query: ITEM_VALUES_QUERY, variables: { id: itemId } },
    expect: "success",
  });
  const actual = new Map<string, string>();
  for (const node of pickArray(parseJsonOutput(readback.stdout), "data.node.fieldValues.nodes")) {
    const fieldId = pickString(node, "field.id");
    if (fieldId === undefined) continue;
    const value =
      pick(node, "text") ?? pick(node, "number") ?? pick(node, "date") ?? pick(node, "optionId");
    if (typeof value === "string" || typeof value === "number") actual.set(fieldId, String(value));
  }
  for (const [fieldId, want] of expected) {
    const got = actual.get(fieldId);
    session.observe({
      id: `project.value.${want.key}.readback`,
      capability: want.capability,
      api: "GraphQL node(ProjectV2Item).fieldValues",
      command: "(compare written value with the readback above)",
      result: got === want.value ? "supported" : "partial",
      detail: got === want.value ? "" : `wrote ${want.value}, read ${got ?? "nothing"}`,
      observed: { written: want.value, read: got ?? null },
    });
  }
}

export async function probeIssues(session: ProbeSession): Promise<void> {
  const parent = await createIssue(session, "parent", "parent (Project item, closed by PR)");
  const childA = await createIssue(session, "childA", "child A (sub-issue, blocked by B)");
  const childB = await createIssue(session, "childB", "child B (removed sub-issue, blocker)");
  await createIssue(session, "dev", "linked by a PR into develop");
  if (parent !== undefined) await probeProjectItem(session, parent);
  if (parent === undefined || childA === undefined || childB === undefined) {
    session.skip("issue.relations", "issue.sub-issue.add", "-", "issues could not be created");
    return;
  }
  await probeSubIssues(session, parent, childA, childB);
  await probeDependencies(session, childA, childB);

  await session.step({
    id: "issue.close.cli",
    capability: "issue.close",
    api: "gh issue close --reason completed",
    args: [
      "issue",
      "close",
      String(childB.number),
      "--repo",
      session.repo,
      "--reason",
      "completed",
    ],
    expect: "success",
  });
  await session.step({
    id: "issue.close.readback",
    capability: "issue.close",
    api: "gh issue view --json state,stateReason",
    args: [
      "issue",
      "view",
      String(childB.number),
      "--repo",
      session.repo,
      "--json",
      "state,stateReason",
    ],
    expect: "success",
    verify: (stdout) => {
      const data = parseJsonOutput(stdout);
      const ok =
        pickString(data, "state") === "CLOSED" && pickString(data, "stateReason") === "COMPLETED";
      return expectTrue(ok, "", `state ${pickString(data, "state") ?? "?"}`);
    },
    observe: (stdout) => {
      const data = parseJsonOutput(stdout);
      return {
        state: pickString(data, "state") ?? null,
        stateReason: pickString(data, "stateReason") ?? null,
      };
    },
  });
}

async function probeSubIssues(
  session: ProbeSession,
  parent: IssueRef,
  childA: IssueRef,
  childB: IssueRef,
): Promise<void> {
  const repo = session.repo;
  for (const child of [childA, childB]) {
    await session.step({
      id: `issue.sub-issue.add.${String(child.number)}`,
      capability: "issue.sub-issue.add",
      api: "REST POST /repos/{r}/issues/{n}/sub_issues",
      args: [
        "api",
        "-X",
        "POST",
        `repos/${repo}/issues/${String(parent.number)}/sub_issues`,
        "--input",
        "-",
      ],
      body: { sub_issue_id: child.id },
      expect: "success",
    });
  }
  const listed =
    (want: number[], forbid: number[]) =>
    (stdout: string): Verdict => {
      const got = numbersAt(parseJsonOutput(stdout), "");
      const ok = want.every((n) => got.includes(n)) && forbid.every((n) => !got.includes(n));
      return expectTrue(ok, "", `listed [${got.join(", ")}]`);
    };
  await session.step({
    id: "issue.sub-issue.list.rest",
    capability: "issue.sub-issue.list",
    api: "REST GET /repos/{r}/issues/{n}/sub_issues",
    args: ["api", `repos/${repo}/issues/${String(parent.number)}/sub_issues`],
    expect: "success",
    verify: listed([childA.number, childB.number], []),
  });
  await session.step({
    id: "issue.sub-issue.parent.rest",
    capability: "issue.sub-issue.list",
    api: "REST GET /repos/{r}/issues/{n}/parent",
    args: ["api", `repos/${repo}/issues/${String(childA.number)}/parent`],
    expect: "success",
    verify: (stdout) => {
      const number = pickNumber(parseJsonOutput(stdout), "number");
      return expectTrue(number === parent.number, "", `parent ${String(number)}`);
    },
  });
  const [owner, name] = repo.split("/");
  await session.step({
    id: "issue.sub-issue.list.graphql",
    capability: "issue.sub-issue.list",
    api: "GraphQL issue.parent / issue.subIssues",
    args: GRAPHQL,
    body: { query: HIERARCHY_QUERY, variables: { owner, name, number: parent.number } },
    expect: "success",
    verify: (stdout) => {
      const got = numbersAt(parseJsonOutput(stdout), "data.repository.issue.subIssues.nodes");
      return expectTrue(got.includes(childA.number), "", `subIssues [${got.join(", ")}]`);
    },
  });
  await session.step({
    id: "issue.sub-issue.remove",
    capability: "issue.sub-issue.remove",
    api: "REST DELETE /repos/{r}/issues/{n}/sub_issue",
    args: [
      "api",
      "-X",
      "DELETE",
      `repos/${repo}/issues/${String(parent.number)}/sub_issue`,
      "--input",
      "-",
    ],
    body: { sub_issue_id: childB.id },
    expect: "success",
  });
  await session.step({
    id: "issue.sub-issue.list.after-remove",
    capability: "issue.sub-issue.remove",
    api: "REST GET /repos/{r}/issues/{n}/sub_issues",
    args: ["api", `repos/${repo}/issues/${String(parent.number)}/sub_issues`],
    expect: "success",
    verify: listed([childA.number], [childB.number]),
  });
}

async function probeDependencies(
  session: ProbeSession,
  blocked: IssueRef,
  blocker: IssueRef,
): Promise<void> {
  const repo = session.repo;
  const base = `repos/${repo}/issues/${String(blocked.number)}/dependencies`;
  const added = await session.step({
    id: "issue.dependency.add.rest",
    capability: "issue.dependency.add",
    api: "REST POST /repos/{r}/issues/{n}/dependencies/blocked_by",
    args: ["api", "-X", "POST", `${base}/blocked_by`, "--input", "-"],
    body: { issue_id: blocker.id },
    expect: "success",
  });
  if (!added.ok) {
    // Fallback path, recorded separately so the matrix shows which API worked.
    await session.step({
      id: "issue.dependency.add.graphql",
      capability: "issue.dependency.add",
      api: "GraphQL addBlockedBy",
      args: GRAPHQL,
      body: {
        query: ADD_BLOCKED_BY_MUTATION,
        variables: { issue: blocked.nodeId, blocking: blocker.nodeId },
      },
      expect: "success",
    });
  }
  await session.step({
    id: "issue.dependency.list.blocked-by",
    capability: "issue.dependency.list",
    api: "REST GET /repos/{r}/issues/{n}/dependencies/blocked_by",
    args: ["api", `${base}/blocked_by`],
    expect: "success",
    verify: (stdout) => {
      const got = numbersAt(parseJsonOutput(stdout), "");
      return expectTrue(got.includes(blocker.number), "", `blocked_by [${got.join(", ")}]`);
    },
  });
  await session.step({
    id: "issue.dependency.list.blocking",
    capability: "issue.dependency.list",
    api: "REST GET /repos/{r}/issues/{n}/dependencies/blocking",
    args: ["api", `repos/${repo}/issues/${String(blocker.number)}/dependencies/blocking`],
    expect: "success",
    verify: (stdout) => {
      const got = numbersAt(parseJsonOutput(stdout), "");
      return expectTrue(got.includes(blocked.number), "", `blocking [${got.join(", ")}]`);
    },
  });
  const [owner, name] = repo.split("/");
  await session.step({
    id: "issue.dependency.list.graphql",
    capability: "issue.dependency.list",
    api: "GraphQL issue.blockedBy / issue.blocking",
    args: GRAPHQL,
    body: { query: DEPENDENCY_QUERY, variables: { owner, name, number: blocked.number } },
    expect: "success",
    verify: (stdout) => {
      const got = numbersAt(parseJsonOutput(stdout), "data.repository.issue.blockedBy.nodes");
      return expectTrue(got.includes(blocker.number), "", `blockedBy [${got.join(", ")}]`);
    },
  });
  await session.step({
    id: "issue.dependency.remove.rest",
    capability: "issue.dependency.remove",
    api: "REST DELETE /repos/{r}/issues/{n}/dependencies/blocked_by/{id}",
    args: ["api", "-X", "DELETE", `${base}/blocked_by/${String(blocker.id)}`],
    expect: "success",
  });
  await session.step({
    id: "issue.dependency.list.after-remove",
    capability: "issue.dependency.remove",
    api: "REST GET /repos/{r}/issues/{n}/dependencies/blocked_by",
    args: ["api", `${base}/blocked_by`],
    expect: "success",
    verify: (stdout) => {
      const got = numbersAt(parseJsonOutput(stdout), "");
      return expectTrue(!got.includes(blocker.number), "", `still blocked_by [${got.join(", ")}]`);
    },
  });
  // Re-add so the Issue page shows the relation during the rest of the run (evidence for the PO).
  await session.step({
    id: "issue.dependency.re-add",
    capability: "issue.dependency.add",
    api: "REST POST /repos/{r}/issues/{n}/dependencies/blocked_by",
    args: ["api", "-X", "POST", `${base}/blocked_by`, "--input", "-"],
    body: { issue_id: blocker.id },
    expect: "success",
  });
}
