// OMI-006 — probes for the PR side: workflow (native check), ruleset (1 approval + required
// check), branches/commits/PRs through the API, PR→Issue linkage, merge permission, approval by
// the right actor and merge gates. Sandbox only.
import type { CapabilityId, Verdict } from "./probe-model.ts";
import {
  numbersAt,
  parseJsonOutput,
  pick,
  pickArray,
  pickNumber,
  pickString,
  type PrKey,
  type PrRef,
  type ProbeSession,
} from "./probe-session.ts";

const GRAPHQL = ["api", "graphql", "--input", "-"] as const;
export const CHECK_NAME = "probe-check";

/**
 * Minimal workflow: `probe-check` passes unless a file under probe-check/ says `fail` (each PR adds
 * its own file, so PRs never conflict); `gated-deploy` targets the protected environment and runs
 * only on workflow_dispatch. The checkout action is pinned like .github/workflows/ci.yml.
 */
export function workflowYaml(defaultBranch: string, environment: string): string {
  return `# Created by the OMI-006 capability probe (omi-squad). Safe to delete.
name: omi-probe
on:
  pull_request:
    branches: [${defaultBranch}]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  ${CHECK_NAME}:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: fail when any probe-check file says fail
        run: "! grep -rqx fail probe-check/"
  gated-deploy:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    environment: ${environment}
    steps:
      - run: echo "gated deploy of $GITHUB_SHA"
`;
}

const PR_STATE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number state merged baseRefName headRefOid
      mergeable mergeStateStatus reviewDecision
      closingIssuesReferences(first: 10) { nodes { number } }
    }
  }
}`;

const PERMISSION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequest(number: $number) { viewerCanMergeAsAdmin viewerCanUpdate }
  }
}`;

const CLOSED_BY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      state
      closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number } }
    }
  }
}`;

function ownerName(session: ProbeSession): { owner: string; name: string } {
  const [owner = "", name = ""] = session.repo.split("/");
  return { owner, name };
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

export interface PrState {
  state: string;
  merged: boolean;
  headSha: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  closingIssues: number[];
}

export async function readPrState(
  session: ProbeSession,
  number: number,
): Promise<PrState | undefined> {
  const { owner, name } = ownerName(session);
  const out = await session.gh(GRAPHQL, {
    query: PR_STATE_QUERY,
    variables: { owner, name, number },
  });
  if (out.code !== 0) return undefined;
  const pr = pick(parseJsonOutput(out.stdout), "data.repository.pullRequest");
  const state = pickString(pr, "state");
  const headSha = pickString(pr, "headRefOid");
  if (state === undefined || headSha === undefined) return undefined;
  return {
    state,
    merged: pick(pr, "merged") === true,
    headSha,
    mergeable: pickString(pr, "mergeable") ?? "UNKNOWN",
    mergeStateStatus: pickString(pr, "mergeStateStatus") ?? "UNKNOWN",
    reviewDecision: pickString(pr, "reviewDecision") ?? null,
    closingIssues: numbersAt(pr, "closingIssuesReferences.nodes"),
  };
}

/** Waits until GitHub has computed mergeability (mergeStateStatus leaves UNKNOWN). */
export async function settledPrState(
  session: ProbeSession,
  number: number,
): Promise<PrState | undefined> {
  return session.poll(
    async () => {
      const pr = await readPrState(session, number);
      return pr !== undefined && pr.mergeStateStatus !== "UNKNOWN" && pr.mergeable !== "UNKNOWN"
        ? pr
        : undefined;
    },
    5_000,
    120,
  );
}

/** Waits for the `probe-check` run on `sha` to complete; returns its conclusion. */
export async function waitForCheck(
  session: ProbeSession,
  sha: string,
): Promise<string | undefined> {
  return session.poll(async () => {
    const out = await session.gh([
      "api",
      `repos/${session.repo}/commits/${sha}/check-runs?check_name=${CHECK_NAME}`,
    ]);
    if (out.code !== 0) return undefined;
    const run = pickArray(parseJsonOutput(out.stdout), "check_runs")[0];
    return pickString(run, "status") === "completed"
      ? (pickString(run, "conclusion") ?? "none")
      : undefined;
  }, 10_000);
}

async function branchSha(session: ProbeSession, branch: string): Promise<string | undefined> {
  const out = await session.gh(["api", `repos/${session.repo}/git/ref/heads/${branch}`]);
  return out.code === 0 ? pickString(parseJsonOutput(out.stdout), "object.sha") : undefined;
}

async function fileSha(
  session: ProbeSession,
  path: string,
  branch: string,
): Promise<string | undefined> {
  const out = await session.gh(["api", `repos/${session.repo}/contents/${path}?ref=${branch}`]);
  return out.code === 0 ? pickString(parseJsonOutput(out.stdout), "sha") : undefined;
}

/** Commits the workflow file to the default branch (before any ruleset exists). */
export async function commitWorkflow(session: ProbeSession): Promise<boolean> {
  const { state } = session;
  const branch = state.defaultBranch ?? "main";
  const path = `.github/workflows/${state.workflowFile}`;
  const sha = await fileSha(session, path, branch);
  const result = await session.step({
    id: "checks.workflow.commit",
    capability: "checks.workflow",
    api: "REST PUT /repos/{r}/contents/{path} (workflow file; needs `workflow` scope)",
    args: ["api", "-X", "PUT", `repos/${session.repo}/contents/${path}`, "--input", "-"],
    body: {
      message: `chore: omi-006 probe workflow (${state.runId})`,
      content: base64(workflowYaml(branch, state.environmentName)),
      branch,
      ...(sha === undefined ? {} : { sha }),
    },
    expect: "success",
    observe: (stdout) => ({ commit: pickString(parseJsonOutput(stdout), "commit.sha") ?? null }),
  });
  state.workflowCommitted = result.ok;
  session.saveState();
  return result.ok;
}

export async function createRuleset(session: ProbeSession): Promise<void> {
  const { state } = session;
  const created = await session.step({
    id: "approval.ruleset.create",
    capability: "approval.ruleset",
    api: "REST POST /repos/{r}/rulesets",
    args: ["api", "-X", "POST", `repos/${session.repo}/rulesets`, "--input", "-"],
    body: {
      name: `omi-probe-${state.runId}`,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      bypass_actors: [],
      rules: [
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: false,
            required_status_checks: [{ context: CHECK_NAME }],
          },
        },
      ],
    },
    expect: "success",
    observe: (stdout) => ({ rulesetId: pickNumber(parseJsonOutput(stdout), "id") ?? null }),
  });
  state.rulesetId = pickNumber(parseJsonOutput(created.stdout), "id") ?? null;
  session.saveState();
  await session.step({
    id: "approval.ruleset.effective-rules",
    capability: "approval.ruleset",
    api: "REST GET /repos/{r}/rules/branches/{branch}",
    args: ["api", `repos/${session.repo}/rules/branches/${state.defaultBranch ?? "main"}`],
    expect: "success",
    verify: (stdout) => {
      const types = pickArray(parseJsonOutput(stdout), "").map((r) => pickString(r, "type"));
      const ok = types.includes("pull_request") && types.includes("required_status_checks");
      return ok
        ? { result: "supported", note: "" }
        : { result: "partial", note: `rules: ${types.join(", ")}` };
    },
  });
}

/** Creates `branch` from `fromSha` and commits one probe file; returns the new head SHA. */
async function branchWithCommit(
  session: ProbeSession,
  key: string,
  branch: string,
  fromSha: string,
  path: string,
  content: string,
): Promise<string | undefined> {
  const ref = await session.step({
    id: `pr.branch.${key}`,
    capability: "pr.branch-commit",
    api: "REST POST /repos/{r}/git/refs",
    args: ["api", "-X", "POST", `repos/${session.repo}/git/refs`, "--input", "-"],
    body: { ref: `refs/heads/${branch}`, sha: fromSha },
    expect: "success",
  });
  if (!ref.ok) return undefined;
  session.state.branches.push(branch);
  session.saveState();
  const commit = await session.step({
    id: `pr.commit.${key}`,
    capability: "pr.branch-commit",
    api: "REST PUT /repos/{r}/contents/{path}",
    args: ["api", "-X", "PUT", `repos/${session.repo}/contents/${path}`, "--input", "-"],
    body: { message: `test: omi-006 probe ${key}`, content: base64(content), branch },
    expect: "success",
  });
  return pickString(parseJsonOutput(commit.stdout), "commit.sha");
}

async function openPr(
  session: ProbeSession,
  key: PrKey,
  branch: string,
  base: string,
  title: string,
  body: string,
): Promise<PrRef | undefined> {
  const created = await session.step({
    id: `pr.create.${key}.cli`,
    capability: "pr.create",
    api: "gh pr create --repo --head --base",
    args: [
      "pr",
      "create",
      "--repo",
      session.repo,
      "--head",
      branch,
      "--base",
      base,
      "--title",
      title,
      "--body",
      body,
    ],
    expect: "success",
  });
  let number = Number(/\/pull\/(\d+)/.exec(created.stdout)?.[1] ?? Number.NaN);
  let url = /https:\/\/\S+\/pull\/\d+/.exec(created.stdout)?.[0];
  if (!created.ok || Number.isNaN(number)) {
    const rest = await session.step({
      id: `pr.create.${key}.rest`,
      capability: "pr.create",
      api: "REST POST /repos/{r}/pulls",
      args: ["api", "-X", "POST", `repos/${session.repo}/pulls`, "--input", "-"],
      body: { title, body, head: branch, base },
      expect: "success",
    });
    const data = parseJsonOutput(rest.stdout);
    number = pickNumber(data, "number") ?? Number.NaN;
    url = pickString(data, "html_url");
  }
  if (Number.isNaN(number) || url === undefined) return undefined;
  const ref: PrRef = { number, url, branch, base };
  session.state.prs[key] = ref;
  session.saveState();
  return ref;
}

/** Setup: branches, commits and the three PRs (approve/check into default, dev into develop). */
export async function createPullRequests(session: ProbeSession): Promise<void> {
  const { state } = session;
  const main = state.defaultBranch ?? "main";
  const parent = state.issues.parent;
  const dev = state.issues.dev;
  const mainSha = await branchSha(session, main);
  if (mainSha === undefined || parent === undefined || dev === undefined) {
    session.skip("pr.all", "pr.create", "-", "default branch SHA or Issues missing");
    return;
  }
  const prefix = `omi-probe/${state.runId}`;
  const file = (key: string) => `probe-check/${state.runId}-${key}.txt`;

  const approveSha = await branchWithCommit(
    session,
    "approve",
    `${prefix}/approve`,
    mainSha,
    file("approve"),
    "pass\n",
  );
  if (approveSha !== undefined) {
    await openPr(
      session,
      "approve",
      `${prefix}/approve`,
      main,
      `omi-probe ${state.runId}: approval gate`,
      `Closes #${String(parent.number)}\n\nIssue: #${String(parent.number)}\n\nOMI-006 capability probe.`,
    );
  }
  const checkSha = await branchWithCommit(
    session,
    "check",
    `${prefix}/check`,
    mainSha,
    file("check"),
    "fail\n",
  );
  if (checkSha !== undefined) {
    await openPr(
      session,
      "check",
      `${prefix}/check`,
      main,
      `omi-probe ${state.runId}: required check gate`,
      `Issue: #${String(parent.number)}\n\nOMI-006 capability probe (explicit reference only, no closing keyword).`,
    );
  }
  const developRef = await session.step({
    id: "pr.branch.develop",
    capability: "pr.branch-commit",
    api: "REST POST /repos/{r}/git/refs",
    args: ["api", "-X", "POST", `repos/${session.repo}/git/refs`, "--input", "-"],
    body: { ref: `refs/heads/${prefix}/develop`, sha: mainSha },
    expect: "success",
  });
  if (developRef.ok) {
    state.branches.push(`${prefix}/develop`);
    session.saveState();
    const devSha = await branchWithCommit(
      session,
      "dev",
      `${prefix}/dev`,
      mainSha,
      file("dev"),
      "pass\n",
    );
    if (devSha !== undefined) {
      await openPr(
        session,
        "dev",
        `${prefix}/dev`,
        `${prefix}/develop`,
        `omi-probe ${state.runId}: PR into non-default base`,
        `Closes #${String(dev.number)}\n\nIssue: #${String(dev.number)}\n\nOMI-006 capability probe.`,
      );
    }
  }
}

/** Setup: how each PR→Issue link form is read back before any merge. */
export async function probeLinkage(session: ProbeSession): Promise<void> {
  const { state } = session;
  const { owner, name } = ownerName(session);
  const parent = state.issues.parent;
  const dev = state.issues.dev;
  const linkStep = async (key: PrKey, capability: CapabilityId, want: number | null) => {
    const pr = state.prs[key];
    if (pr === undefined) return;
    await session.step({
      id: `pr.link.${key}.closing-references`,
      capability,
      api: "GraphQL pullRequest.closingIssuesReferences",
      args: GRAPHQL,
      body: { query: PR_STATE_QUERY, variables: { owner, name, number: pr.number } },
      expect: "success",
      verify: (stdout): Verdict => {
        const got = numbersAt(
          parseJsonOutput(stdout),
          "data.repository.pullRequest.closingIssuesReferences.nodes",
        );
        if (want === null) {
          return got.length === 0
            ? {
                result: "supported",
                note: "`Issue: #N` creates no closing reference (as expected)",
              }
            : { result: "partial", note: `unexpected closing references [${got.join(", ")}]` };
        }
        return got.includes(want)
          ? { result: "supported", note: `closing reference to #${String(want)}` }
          : { result: "unsupported", note: `no closing reference (got [${got.join(", ")}])` };
      },
    });
  };
  if (parent !== undefined) await linkStep("approve", "pr.link.closing-keyword", parent.number);
  await linkStep("check", "pr.link.explicit-reference", null);
  if (dev !== undefined) await linkStep("dev", "pr.link.non-default-base", dev.number);

  const checkPr = state.prs.check;
  if (parent !== undefined && checkPr !== undefined) {
    // The timeline is indexed asynchronously; poll the REST timeline for the cross-reference.
    const found = await session.poll(
      async () => {
        const out = await session.gh([
          "api",
          `repos/${session.repo}/issues/${String(parent.number)}/timeline?per_page=100`,
        ]);
        const hit = pickArray(parseJsonOutput(out.stdout), "").some(
          (e) =>
            pickString(e, "event") === "cross-referenced" &&
            pickNumber(e, "source.issue.number") === checkPr.number,
        );
        return hit ? true : undefined;
      },
      5_000,
      90,
    );
    await session.step({
      id: "pr.link.explicit-reference.timeline",
      capability: "pr.link.explicit-reference",
      api: "REST GET /repos/{r}/issues/{n}/timeline (cross-referenced)",
      args: ["api", `repos/${session.repo}/issues/${String(parent.number)}/timeline?per_page=100`],
      expect: "success",
      verify: () =>
        found === true
          ? { result: "supported", note: `cross-referenced by PR #${String(checkPr.number)}` }
          : { result: "unsupported", note: "no cross-referenced event within 90 s" },
    });
  }
}

async function permissionStep(session: ProbeSession, key: PrKey, label: string): Promise<void> {
  const pr = session.state.prs[key];
  if (pr === undefined) return;
  const { owner, name } = ownerName(session);
  await session.step({
    id: `pr.merge-permission.${key}.${label}`,
    capability: "pr.merge-permission",
    api: "GraphQL repository.viewerPermission, pullRequest.viewerCanMergeAsAdmin",
    args: GRAPHQL,
    body: { query: PERMISSION_QUERY, variables: { owner, name, number: pr.number } },
    expect: "success",
    observe: (stdout) => {
      const data = parseJsonOutput(stdout);
      const canAdmin = pick(data, "data.repository.pullRequest.viewerCanMergeAsAdmin");
      return {
        viewerPermission: pickString(data, "data.repository.viewerPermission") ?? null,
        viewerCanMergeAsAdmin: typeof canAdmin === "boolean" ? canAdmin : null,
      };
    },
  });
}

function observePrState(
  session: ProbeSession,
  id: string,
  capability: CapabilityId,
  pr: PrState | undefined,
  want: (p: PrState) => boolean,
  label: string,
): void {
  session.observe({
    id,
    capability,
    api: "GraphQL pullRequest.mergeable/mergeStateStatus/reviewDecision",
    command: "(polled until mergeStateStatus is not UNKNOWN)",
    result: pr === undefined ? "error" : want(pr) ? "supported" : "partial",
    detail: pr === undefined ? "PR state could not be read" : label,
    observed:
      pr === undefined
        ? {}
        : {
            mergeable: pr.mergeable,
            mergeStateStatus: pr.mergeStateStatus,
            reviewDecision: pr.reviewDecision,
            headSha: pr.headSha,
          },
  });
}

function restMerge(
  session: ProbeSession,
  id: string,
  capability: CapabilityId,
  pr: PrRef,
  expect: "success" | "denied",
) {
  return session.step({
    id,
    capability,
    api: "REST PUT /repos/{r}/pulls/{n}/merge",
    args: [
      "api",
      "-X",
      "PUT",
      `repos/${session.repo}/pulls/${String(pr.number)}/merge`,
      "--input",
      "-",
    ],
    body: { merge_method: "merge" },
    expect,
  });
}

/** Setup: waits for both checks, then probes the gates before any approval exists. */
export async function probeGatesBeforeApproval(session: ProbeSession): Promise<void> {
  const { state } = session;
  const approve = state.prs.approve;
  const check = state.prs.check;
  for (const [key, pr, want] of [
    ["approve", approve, "success"],
    ["check", check, "failure"],
  ] as const) {
    if (pr === undefined) continue;
    const head = await readPrState(session, pr.number);
    const conclusion = head === undefined ? undefined : await waitForCheck(session, head.headSha);
    session.observe({
      id: `checks.workflow.${key}.reported`,
      capability: "checks.workflow",
      api: "REST GET /repos/{r}/commits/{sha}/check-runs?check_name=probe-check",
      command: `(polled up to ${String(session.waitSeconds)} s)`,
      result: conclusion === undefined ? "error" : conclusion === want ? "supported" : "partial",
      detail:
        conclusion === undefined
          ? "no completed probe-check run"
          : `conclusion ${conclusion}, expected ${want}`,
      observed: { conclusion: conclusion ?? null, headSha: head?.headSha ?? null },
    });
  }
  if (check !== undefined) await probeCheckReads(session, check, "failing");

  if (approve !== undefined) {
    await permissionStep(session, "approve", "before-approval");
    const before = await settledPrState(session, approve.number);
    observePrState(
      session,
      "approval.blocks-merge.state-before",
      "approval.blocks-merge",
      before,
      (p) => p.mergeStateStatus === "BLOCKED" && p.reviewDecision === "REVIEW_REQUIRED",
      "expected BLOCKED / REVIEW_REQUIRED with a green check",
    );
    await restMerge(
      session,
      "approval.blocks-merge.rest-before",
      "approval.blocks-merge",
      approve,
      "denied",
    );
    await session.step({
      id: "approval.blocks-merge.cli-before",
      capability: "approval.blocks-merge",
      api: "gh pr merge --merge",
      args: ["pr", "merge", String(approve.number), "--repo", session.repo, "--merge"],
      expect: "denied",
    });
    await session.step({
      id: "approval.self-approval.cli",
      capability: "approval.self-approval-denied",
      api: "gh pr review --approve (PR author)",
      args: [
        "pr",
        "review",
        String(approve.number),
        "--repo",
        session.repo,
        "--approve",
        "--body",
        "omi-006 probe: self-approval attempt",
      ],
      expect: "denied",
    });
  }
  if (check !== undefined) {
    await restMerge(
      session,
      "approval.admin-bypass.rest",
      "approval.admin-bypass-denied",
      check,
      "denied",
    );
    await session.step({
      id: "approval.admin-bypass.cli",
      capability: "approval.admin-bypass-denied",
      api: "gh pr merge --admin",
      args: ["pr", "merge", String(check.number), "--repo", session.repo, "--merge", "--admin"],
      expect: "denied",
    });
  }
}

/** Reads the probe-check result for a PR head through the three available read paths. */
export async function probeCheckReads(
  session: ProbeSession,
  pr: PrRef,
  label: string,
): Promise<void> {
  const head = await readPrState(session, pr.number);
  if (head === undefined) return;
  let restConclusion: string | undefined;
  await session.step({
    id: `checks.read.${label}.check-runs`,
    capability: "checks.read",
    api: "REST GET /repos/{r}/commits/{sha}/check-runs",
    args: ["api", `repos/${session.repo}/commits/${head.headSha}/check-runs`],
    expect: "success",
    observe: (stdout) => {
      const runs = pickArray(parseJsonOutput(stdout), "check_runs");
      const run = runs.find((r) => pickString(r, "name") === CHECK_NAME);
      restConclusion = pickString(run, "conclusion");
      return {
        headSha: head.headSha,
        conclusion: restConclusion ?? null,
        app: pickString(run, "app.slug") ?? null,
        runs: runs.length,
      };
    },
  });
  await session.step({
    id: `checks.read.${label}.gh-pr-checks`,
    capability: "checks.read",
    api: "gh pr checks --json name,state,bucket (exit 1 = failing, 8 = pending)",
    args: [
      "pr",
      "checks",
      String(pr.number),
      "--repo",
      session.repo,
      "--json",
      "name,state,bucket,workflow",
    ],
    expect: "success",
    okExitCodes: [1, 8],
    verify: (stdout): Verdict => {
      const entry = pickArray(parseJsonOutput(stdout), "").find(
        (c) => pickString(c, "name") === CHECK_NAME,
      );
      const bucket = pickString(entry, "bucket");
      const agrees =
        (bucket === "pass" && restConclusion === "success") ||
        (bucket === "fail" && restConclusion === "failure");
      return agrees
        ? {
            result: "supported",
            note: `bucket ${bucket} matches check-runs ${restConclusion ?? "?"}`,
          }
        : {
            result: "partial",
            note: `bucket ${bucket ?? "?"} vs check-runs ${restConclusion ?? "?"}`,
          };
    },
  });
  await session.step({
    id: `checks.read.${label}.status-rollup`,
    capability: "checks.read",
    api: "gh pr view --json statusCheckRollup",
    args: [
      "pr",
      "view",
      String(pr.number),
      "--repo",
      session.repo,
      "--json",
      "statusCheckRollup,headRefOid",
    ],
    expect: "success",
    observe: (stdout) => {
      const entry = pickArray(parseJsonOutput(stdout), "statusCheckRollup").find(
        (c) => pickString(c, "name") === CHECK_NAME,
      );
      return {
        conclusion: pickString(entry, "conclusion") ?? null,
        status: pickString(entry, "status") ?? null,
      };
    },
  });
}

/** Approve phase (second actor): approve both PRs and read the decision back. */
export async function approvePullRequests(session: ProbeSession): Promise<void> {
  for (const key of ["approve", "check"] as const) {
    const pr = session.state.prs[key];
    if (pr === undefined) continue;
    await session.step({
      id: `approval.other-actor.${key}`,
      capability: "approval.other-actor",
      api: "gh pr review --approve (second actor)",
      args: [
        "pr",
        "review",
        String(pr.number),
        "--repo",
        session.repo,
        "--approve",
        "--body",
        "omi-006 probe: approval by the second actor",
      ],
      expect: "success",
    });
    await session.step({
      id: `approval.other-actor.${key}.readback`,
      capability: "approval.other-actor",
      api: "gh pr view --json reviewDecision,latestReviews",
      args: [
        "pr",
        "view",
        String(pr.number),
        "--repo",
        session.repo,
        "--json",
        "reviewDecision,latestReviews,headRefOid",
      ],
      expect: "success",
      verify: (stdout): Verdict => {
        const data = parseJsonOutput(stdout);
        const decision = pickString(data, "reviewDecision");
        const approvedBy = pickArray(data, "latestReviews")
          .filter((r) => pickString(r, "state") === "APPROVED")
          .map((r) => pickString(r, "author.login"));
        return decision === "APPROVED" && approvedBy.includes(session.actor)
          ? { result: "supported", note: `APPROVED by ${session.actor}` }
          : {
              result: "partial",
              note: `reviewDecision ${decision ?? "?"}, approvals by ${approvedBy.join(", ")}`,
            };
      },
      observe: (stdout) => ({
        reviewDecision: pickString(parseJsonOutput(stdout), "reviewDecision") ?? null,
        headSha: pickString(parseJsonOutput(stdout), "headRefOid") ?? null,
      }),
    });
  }
}

async function waitIssueState(
  session: ProbeSession,
  number: number,
  seconds: number,
): Promise<string | undefined> {
  const { owner, name } = ownerName(session);
  let last: string | undefined;
  await session.poll(
    async () => {
      const out = await session.gh(GRAPHQL, {
        query: CLOSED_BY_QUERY,
        variables: { owner, name, number },
      });
      last = pickString(parseJsonOutput(out.stdout), "data.repository.issue.state");
      return last === "CLOSED" ? last : undefined;
    },
    5_000,
    seconds,
  );
  return last;
}

async function mergeCli(
  session: ProbeSession,
  id: string,
  capability: CapabilityId,
  pr: PrRef,
): Promise<boolean> {
  const merged = await session.step({
    id,
    capability,
    api: "gh pr merge --merge",
    args: ["pr", "merge", String(pr.number), "--repo", session.repo, "--merge"],
    expect: "success",
  });
  const after = await readPrState(session, pr.number);
  session.observe({
    id: `${id}.readback`,
    capability: "pr.merge",
    api: "GraphQL pullRequest.merged",
    command: "(read after merge)",
    result: after?.merged === true ? "supported" : merged.ok ? "partial" : "error",
    detail: after?.merged === true ? "" : "PR not merged",
    observed: { merged: after?.merged ?? null, state: after?.state ?? null },
  });
  return after?.merged === true;
}

/** Verify phase (author): merges after approval, required-check gate until green, link effects. */
export async function verifyPullRequests(session: ProbeSession): Promise<void> {
  const { state } = session;
  const { owner, name } = ownerName(session);
  const approve = state.prs.approve;
  const check = state.prs.check;
  const dev = state.prs.dev;

  if (approve !== undefined) {
    await permissionStep(session, "approve", "after-approval");
    const ready = await settledPrState(session, approve.number);
    observePrState(
      session,
      "approval.blocks-merge.state-after",
      "approval.blocks-merge",
      ready,
      (p) =>
        p.reviewDecision === "APPROVED" &&
        ["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(p.mergeStateStatus),
      "expected APPROVED and mergeable after the second actor approved",
    );
    const merged = await mergeCli(
      session,
      "approval.blocks-merge.merge-after",
      "approval.blocks-merge",
      approve,
    );
    const parent = state.issues.parent;
    if (merged && parent !== undefined) {
      const issueState = await waitIssueState(session, parent.number, 60);
      await session.step({
        id: "pr.link.closing-keyword.closed-by",
        capability: "pr.link.closing-keyword",
        api: "GraphQL issue.state, issue.closedByPullRequestsReferences",
        args: GRAPHQL,
        body: { query: CLOSED_BY_QUERY, variables: { owner, name, number: parent.number } },
        expect: "success",
        verify: (stdout): Verdict => {
          const prs = numbersAt(
            parseJsonOutput(stdout),
            "data.repository.issue.closedByPullRequestsReferences.nodes",
          );
          return issueState === "CLOSED" && prs.includes(approve.number)
            ? { result: "supported", note: "Issue closed by the merge into the default branch" }
            : {
                result: "partial",
                note: `issue ${issueState ?? "?"}, closedBy [${prs.join(", ")}]`,
              };
        },
      });
    }
  }

  if (check !== undefined) {
    const blocked = await settledPrState(session, check.number);
    observePrState(
      session,
      "checks.required-blocks.state-failing",
      "checks.required-blocks",
      blocked,
      (p) => p.reviewDecision === "APPROVED" && p.mergeStateStatus === "BLOCKED",
      "expected BLOCKED by the failing required check although approved",
    );
    await restMerge(
      session,
      "checks.required-blocks.rest-failing",
      "checks.required-blocks",
      check,
      "denied",
    );
    const path = `probe-check/${state.runId}-check.txt`;
    const sha = await fileSha(session, path, check.branch);
    const fix = await session.step({
      id: "checks.required-blocks.fix-commit",
      capability: "pr.branch-commit",
      api: "REST PUT /repos/{r}/contents/{path}",
      args: ["api", "-X", "PUT", `repos/${session.repo}/contents/${path}`, "--input", "-"],
      body: {
        message: "test: omi-006 probe make check green",
        content: base64("pass\n"),
        branch: check.branch,
        ...(sha === undefined ? {} : { sha }),
      },
      expect: "success",
    });
    const newHead = pickString(parseJsonOutput(fix.stdout), "commit.sha");
    const conclusion = newHead === undefined ? undefined : await waitForCheck(session, newHead);
    session.observe({
      id: "checks.required-blocks.green",
      capability: "checks.workflow",
      api: "REST GET /repos/{r}/commits/{sha}/check-runs?check_name=probe-check",
      command: `(polled up to ${String(session.waitSeconds)} s)`,
      result:
        conclusion === "success" ? "supported" : conclusion === undefined ? "error" : "partial",
      detail: `conclusion ${conclusion ?? "none"} on the fix commit`,
      observed: { headSha: newHead ?? null, conclusion: conclusion ?? null },
    });
    await probeCheckReads(session, check, "green");
    const green = await settledPrState(session, check.number);
    observePrState(
      session,
      "checks.required-blocks.state-green",
      "checks.required-blocks",
      green,
      (p) => p.reviewDecision === "APPROVED" && p.mergeStateStatus !== "BLOCKED",
      "expected unblocked once green; approval kept (dismiss_stale_reviews_on_push=false)",
    );
    await mergeCli(session, "checks.required-blocks.merge-green", "checks.required-blocks", check);
  }

  if (dev !== undefined) {
    const merged = await mergeCli(session, "pr.merge.non-default-base", "pr.merge", dev);
    const issue = state.issues.dev;
    if (merged && issue !== undefined) {
      const issueState = await waitIssueState(session, issue.number, 45);
      session.observe({
        id: "pr.link.non-default-base.issue-after-merge",
        capability: "pr.link.non-default-base",
        api: "GraphQL issue.state",
        command: "(polled 45 s after merging the PR into the non-default base)",
        result: issueState === "CLOSED" ? "supported" : "unsupported",
        detail:
          issueState === "CLOSED"
            ? "closing keyword closed the Issue"
            : `Issue stays ${issueState ?? "?"}: closing keyword ignored for a non-default base`,
        observed: { issueState: issueState ?? null },
      });
    }
  }
}
