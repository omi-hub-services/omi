// Project/PR snapshot for the status script: one GraphQL query, boundary parsing and the pure
// classification rules (status grouping, Ready-with-closed-blockers, check and review state).
import { issueReadinessReasons } from "./issue-readiness.ts";
import { COORDINATOR_LOGIN, PRIORITY_ORDER, STATUS_ORDER } from "./coordinator-settings.ts";
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  authoredComments,
  nodes,
  optObject,
  optString,
  type AuthoredComment,
  type JsonObject,
} from "./json-shape.ts";

const BLOCKER_PAGE = 20;

const ITEM_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes {
    status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    workType: fieldValueByName(name: "Work Type") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    workflow: fieldValueByName(name: "Workflow") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    role: fieldValueByName(name: "Role") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    area: fieldValueByName(name: "Area") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    planKey: fieldValueByName(name: "Plan Key") { ... on ProjectV2ItemFieldTextValue { text } }
    content {
      __typename
      ... on Issue {
        number title state body
        milestone { title }
        blockedBy(first: ${String(BLOCKER_PAGE)}) { totalCount nodes { number state } }
      }
      ... on PullRequest { number title state }
      ... on DraftIssue { title }
    }
  }`;

/** What `parsePull` reads; shared by the snapshot and the flow script's merge read. */
export const PULL_FIELDS = `
  number title isDraft headRefName headRefOid baseRefName body reviewDecision mergeStateStatus
  comments(last: 50) { nodes { author { login } body } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
    __typename
    ... on CheckRun { name status conclusion }
    ... on StatusContext { context state }
  } } } } } }`;

/** Items page plus open PRs; later pages pass `withPulls: false`. */
export const SNAPSHOT_QUERY = `
query($owner: String!, $repo: String!, $project: Int!, $after: String, $withPulls: Boolean!) {
  organization(login: $owner) {
    projectV2(number: $project) { title items(first: 100, after: $after) { ${ITEM_FIELDS} } }
  }
  repository(owner: $owner, name: $repo) @include(if: $withPulls) {
    pullRequests(states: OPEN, first: 30, orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes { ${PULL_FIELDS} }
    }
  }
}`;

// ── parsed shapes ────────────────────────────────────────────────────────────
export interface Blocker {
  readonly number: number;
  readonly state: string;
}

export interface ProjectItem {
  readonly kind: "Issue" | "PullRequest" | "DraftIssue";
  readonly number: number | null;
  readonly title: string;
  readonly state: string | null;
  readonly status: string | null;
  readonly priority: string | null;
  readonly workType: string | null;
  readonly planKey: string | null;
  readonly body: string;
  readonly workflow: string | null;
  readonly role: string | null;
  readonly area: string | null;
  readonly milestone: string | null;
  readonly blockers: readonly Blocker[];
  /** More blockers exist than were fetched; treat as blocked. */
  readonly blockersTruncated: boolean;
}

export interface CheckContext {
  readonly name: string;
  readonly state: CheckState;
}

export interface OpenPull {
  readonly number: number;
  readonly title: string;
  readonly isDraft: boolean;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly body: string;
  readonly reviewDecision: string | null;
  readonly mergeStateStatus: string;
  readonly comments: readonly AuthoredComment[];
  readonly checks: readonly CheckContext[];
}

export interface SnapshotPage {
  readonly projectTitle: string;
  readonly items: readonly ProjectItem[];
  readonly nextCursor: string | null;
  readonly pulls: readonly OpenPull[] | null;
}

const selectName = (v: unknown, path: string) =>
  optString(optObject(v, path)?.name, `${path}.name`);

function parseItem(raw: unknown, path: string): ProjectItem | null {
  const item = asObject(raw, path);
  const content = optObject(item.content, `${path}.content`);
  if (!content) return null; // item whose content the token cannot see
  const kind = asString(content.__typename, `${path}.content.__typename`);
  if (kind !== "Issue" && kind !== "PullRequest" && kind !== "DraftIssue") return null;
  const blockedBy = optObject(content.blockedBy, `${path}.blockedBy`);
  const blockers = blockedBy
    ? asArray(blockedBy.nodes, `${path}.blockedBy.nodes`).map((b, i) => {
        const o = asObject(b, `${path}.blockedBy.nodes[${String(i)}]`);
        return { number: asNumber(o.number, "blocker.number"), state: asString(o.state, "state") };
      })
    : [];
  const total = blockedBy ? asNumber(blockedBy.totalCount, `${path}.blockedBy.totalCount`) : 0;
  return {
    kind,
    number: kind === "DraftIssue" ? null : asNumber(content.number, `${path}.content.number`),
    title: asString(content.title, `${path}.content.title`),
    state: kind === "DraftIssue" ? null : asString(content.state, `${path}.content.state`),
    status: selectName(item.status, `${path}.status`),
    priority: selectName(item.priority, `${path}.priority`),
    workType: selectName(item.workType, `${path}.workType`),
    planKey: optString(optObject(item.planKey, `${path}.planKey`)?.text, `${path}.planKey.text`),
    body: kind === "Issue" ? asString(content.body, `${path}.content.body`) : "",
    workflow: selectName(item.workflow, `${path}.workflow`),
    role: selectName(item.role, `${path}.role`),
    area: selectName(item.area, `${path}.area`),
    milestone: optString(
      optObject(content.milestone, `${path}.milestone`)?.title,
      `${path}.milestone.title`,
    ),
    blockers,
    blockersTruncated: total > blockers.length,
  };
}

export function parseCheck(raw: unknown, path: string): CheckContext {
  const c = asObject(raw, path);
  if (c.__typename === "CheckRun") {
    return {
      name: asString(c.name, `${path}.name`),
      state: checkRunState(asString(c.status, `${path}.status`), optString(c.conclusion, "c")),
    };
  }
  return {
    name: asString(c.context, `${path}.context`),
    state: statusContextState(asString(c.state, `${path}.state`)),
  };
}

export function parsePull(raw: unknown, path: string): OpenPull {
  const p = asObject(raw, path);
  const commit = nodes(p, "commits", path)[0];
  const rollup = commit
    ? optObject(asObject(asObject(commit, "commit").commit, "commit").statusCheckRollup, "rollup")
    : null;
  return {
    number: asNumber(p.number, `${path}.number`),
    title: asString(p.title, `${path}.title`),
    isDraft: asBoolean(p.isDraft, `${path}.isDraft`),
    headRefName: asString(p.headRefName, `${path}.headRefName`),
    headRefOid: asString(p.headRefOid, `${path}.headRefOid`),
    baseRefName: asString(p.baseRefName, `${path}.baseRefName`),
    body: asString(p.body, `${path}.body`),
    reviewDecision: optString(p.reviewDecision, `${path}.reviewDecision`),
    mergeStateStatus: asString(p.mergeStateStatus, `${path}.mergeStateStatus`),
    comments: authoredComments(p, path),
    checks: rollup
      ? nodes(rollup, "contexts", `${path}.rollup`).map((c, i) =>
          parseCheck(c, `${path}.checks[${String(i)}]`),
        )
      : [],
  };
}

export function parseSnapshotPage(data: JsonObject): SnapshotPage {
  const org = asObject(data.organization, "organization");
  const project = optObject(org.projectV2, "organization.projectV2");
  if (!project) throw new Error("Project not found or not visible to this gh account");
  const items = asObject(project.items, "projectV2.items");
  const pageInfo = asObject(items.pageInfo, "items.pageInfo");
  const repo = optObject(data.repository, "repository");
  return {
    projectTitle: asString(project.title, "projectV2.title"),
    items: asArray(items.nodes, "items.nodes")
      .map((n, i) => parseItem(n, `items[${String(i)}]`))
      .filter((i): i is ProjectItem => i !== null),
    nextCursor: asBoolean(pageInfo.hasNextPage, "pageInfo.hasNextPage")
      ? asString(pageInfo.endCursor, "pageInfo.endCursor")
      : null,
    pulls: repo
      ? nodes(repo, "pullRequests", "repository").map((p, i) => parsePull(p, `pulls[${String(i)}]`))
      : null,
  };
}

// ── classification ───────────────────────────────────────────────────────────
export type CheckState = "pass" | "fail" | "pending";

export function checkRunState(status: string, conclusion: string | null): CheckState {
  if (status !== "COMPLETED") return "pending";
  return conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED"
    ? "pass"
    : "fail";
}

export function statusContextState(state: string): CheckState {
  if (state === "SUCCESS") return "pass";
  return state === "PENDING" || state === "EXPECTED" ? "pending" : "fail";
}

export interface ChecksSummary {
  /** pass only when every required check passed and nothing failed. */
  readonly overall: "pass" | "fail" | "pending" | "none";
  readonly failing: readonly string[];
  readonly pending: readonly string[];
  readonly missingRequired: readonly string[];
}

export function summarizeChecks(
  checks: readonly CheckContext[],
  required: readonly string[],
): ChecksSummary {
  const failing = checks.filter((c) => c.state === "fail").map((c) => c.name);
  const pending = checks.filter((c) => c.state === "pending").map((c) => c.name);
  const passed = new Set(checks.filter((c) => c.state === "pass").map((c) => c.name));
  const reported = new Set(checks.map((c) => c.name));
  const missingRequired = required.filter((r) => !reported.has(r));
  let overall: ChecksSummary["overall"];
  if (failing.length > 0) overall = "fail";
  else if (checks.length === 0) overall = "none";
  else if (pending.length > 0 || !required.every((r) => passed.has(r))) overall = "pending";
  else overall = "pass";
  return { overall, failing, pending, missingRequired };
}

const VERDICT = /VERDICT:\**\s*([A-Z_]+)[\s\S]*?REVIEWED_HEAD:\**\s*`?([0-9a-f]{7,40})/;

export interface ReviewState {
  readonly native: string | null;
  /** Latest independent agent review comment (`VERDICT: … REVIEWED_HEAD: <sha>`). */
  readonly agent: {
    readonly verdict: string;
    readonly head: string;
    readonly current: boolean;
  } | null;
  /** Logins (deduplicated) of `VERDICT` comments ignored because another account posted them. */
  readonly ignoredVerdictAuthors: readonly string[];
}

export interface AgentReview {
  readonly verdict: string;
  readonly head: string;
  readonly body: string;
}

const GHOST = "(deleted account)";

/**
 * Newest comment by the Coordinator account carrying `VERDICT: … REVIEWED_HEAD: <sha>`;
 * comments are oldest first. A `VERDICT` from any other account is not a review.
 */
export function latestAgentReview(
  comments: readonly AuthoredComment[],
  coordinator: string = COORDINATOR_LOGIN,
): AgentReview | null {
  for (const c of [...comments].reverse()) {
    if (c.author !== coordinator) continue;
    const m = VERDICT.exec(c.body);
    if (m?.[1] && m[2]) return { verdict: m[1], head: m[2], body: c.body };
  }
  return null;
}

/** Authors other than the Coordinator whose comments look like an agent review. */
export function foreignVerdictAuthors(
  comments: readonly AuthoredComment[],
  coordinator: string = COORDINATOR_LOGIN,
): string[] {
  const authors = comments
    .filter((c) => c.author !== coordinator && VERDICT.test(c.body))
    .map((c) => c.author ?? GHOST);
  return [...new Set(authors)];
}

export function classifyReview(
  pull: {
    readonly reviewDecision: string | null;
    readonly headRefOid: string;
    readonly comments: readonly AuthoredComment[];
  },
  coordinator: string = COORDINATOR_LOGIN,
): ReviewState {
  const r = latestAgentReview(pull.comments, coordinator);
  const agent = r && {
    verdict: r.verdict,
    head: r.head,
    current: pull.headRefOid.startsWith(r.head),
  };
  return {
    native: pull.reviewDecision,
    agent,
    ignoredVerdictAuthors: foreignVerdictAuthors(pull.comments, coordinator),
  };
}

/** status.ts "Attention" lines for open PRs carrying a `VERDICT` from another account. */
export function ignoredVerdictWarnings(
  pulls: readonly { readonly number: number; readonly review: ReviewState }[],
  coordinator: string = COORDINATOR_LOGIN,
): string[] {
  return pulls
    .filter((p) => p.review.ignoredVerdictAuthors.length > 0)
    .map(
      (p) =>
        `PR #${String(p.number)}: ignored VERDICT comment from ${p.review.ignoredVerdictAuthors.join(", ")}` +
        ` (only ${coordinator} counts)`,
    );
}

const ISSUE_LINK = /^Issue:\s*#(\d+)\b/m;

export function linkedIssue(body: string): number | null {
  const m = ISSUE_LINK.exec(body);
  return m?.[1] ? Number(m[1]) : null;
}

const rank = (order: readonly string[], value: string | null) => {
  const i = value === null ? -1 : order.indexOf(value);
  return i === -1 ? order.length : i;
};

export interface StatusGroup {
  readonly status: string;
  readonly items: readonly ProjectItem[];
}

/** Groups in board order; unknown statuses follow, items without Status last as "(none)". */
export function groupByStatus(items: readonly ProjectItem[]): StatusGroup[] {
  const groups = new Map<string, ProjectItem[]>();
  for (const s of STATUS_ORDER) groups.set(s, []);
  for (const item of items) {
    const key = item.status ?? "(none)";
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const none = groups.get("(none)");
  groups.delete("(none)");
  if (none) groups.set("(none)", none);
  return [...groups].map(([status, list]) => ({ status, items: list }));
}

export interface ReadyTask {
  readonly item: ProjectItem;
  readonly openBlockers: readonly number[];
}

/**
 * Ready, open, non-Epic Issues split into unblocked (every blocker closed) and blocked; both
 * sorted by priority, then milestone, then Issue number. An unknown blocker count is blocked.
 */
export function partitionReady(items: readonly ProjectItem[]): {
  unblocked: ReadyTask[];
  blocked: ReadyTask[];
} {
  const ready = items
    .filter((i) => i.kind === "Issue" && i.status === "Ready" && i.state === "OPEN")
    .filter((i) => i.workType !== "Epic")
    .sort(
      (a, b) =>
        rank(PRIORITY_ORDER, a.priority) - rank(PRIORITY_ORDER, b.priority) ||
        (a.milestone ?? "~").localeCompare(b.milestone ?? "~") ||
        (a.number ?? 0) - (b.number ?? 0),
    )
    .map((item) => ({
      item,
      openBlockers: item.blockers.filter((b) => b.state !== "CLOSED").map((b) => b.number),
    }));
  return {
    unblocked: ready.filter((r) => r.openBlockers.length === 0 && !r.item.blockersTruncated),
    blocked: ready.filter((r) => r.openBlockers.length > 0 || r.item.blockersTruncated),
  };
}

/** Status and Issue state that disagree (Done must follow a real close, and vice versa). */
export function findMismatches(items: readonly ProjectItem[]): string[] {
  const out: string[] = [];
  for (const i of items) {
    if (i.kind !== "Issue" || i.number === null) continue;
    if (i.status === "Done" && i.state === "OPEN")
      out.push(`#${String(i.number)} is Done but open`);
    if (i.status !== "Done" && i.state === "CLOSED") {
      out.push(`#${String(i.number)} is closed but Status is ${i.status ?? "(none)"}`);
    }
  }
  return out;
}

/** Legacy Issues are reported, never rejected while reading status. */
export function issueReadinessWarnings(items: readonly ProjectItem[]): string[] {
  return items.flatMap((item) => {
    if (
      item.kind !== "Issue" ||
      item.state !== "OPEN" ||
      item.workType === "Epic" ||
      item.planKey?.startsWith("EP-")
    )
      return [];
    const reasons = issueReadinessReasons(item);
    return reasons.length === 0 ? [] : [`#${String(item.number)}: ${reasons.join("; ")}`];
  });
}
