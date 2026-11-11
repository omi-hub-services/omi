import { z } from "zod";
import {
  mergeableStateSchema,
  nativeReviewsSchema,
} from "../../application/contracts/merge-delivery.js";
import type {
  BranchRules,
  CheckObservations,
  NativeReviews,
} from "../../application/contracts/merge-delivery.js";
import type { MergeDeliveryReader } from "../../application/ports/merge-delivery.js";
import { DeliveryError } from "../../application/ports/pr-delivery.js";
import type { GithubRestClient, PageVisit } from "./github-rest-client.js";

const numberSchema = z.number().int().positive();
const repoRef = z.looseObject({ full_name: z.string() });
const pullSchema = z.looseObject({
  number: numberSchema,
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  draft: z.boolean().optional(),
  body: z.string().nullable(),
  user: z.looseObject({ login: z.string() }),
  head: z.looseObject({ sha: z.string(), repo: repoRef.nullable() }),
  base: z.looseObject({ ref: z.string(), repo: repoRef }),
  mergeable_state: z.string().optional(),
  merge_commit_sha: z.string().nullable(),
});
const issueSchema = z.looseObject({
  number: numberSchema,
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  body: z.string().nullable(),
});
const branchSchema = z.looseObject({ commit: z.looseObject({ sha: z.string() }) });
const ruleSchema = z.looseObject({ type: z.string(), parameters: z.unknown().optional() });
const pullRequestRule = z.looseObject({ required_approving_review_count: z.number().int().min(0) });
const statusChecksRule = z.looseObject({
  required_status_checks: z.array(z.looseObject({ context: z.string() })),
});
const checkRunPage = z.looseObject({
  check_runs: z.array(
    z.looseObject({
      id: numberSchema,
      name: z.string(),
      head_sha: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
    }),
  ),
});
const statusPage = z.array(z.looseObject({ context: z.string(), state: z.string() }));
const reviewPage = z.array(
  z.looseObject({
    user: z.looseObject({ login: z.string(), type: z.string() }).nullable(),
    state: z.string(),
    commit_id: z.string().nullable(),
  }),
);
const userSchema = z.looseObject({ login: z.string().min(1) });
const commitSchema = z.looseObject({
  sha: z.string(),
  parents: z.array(z.looseObject({ sha: z.string() })),
});
const compareSchema = z.looseObject({
  status: z.enum(["identical", "ahead", "behind", "diverged"]),
});

const reviewStateSchema = nativeReviewsSchema.element.shape.state;

/**
 * GitHub reads for `mergeTaskPr` over the REST client. Every listing is read to the end and every
 * failure throws, so a missing check or review never reads as "none required" or "passed". This
 * adapter only reads; it never submits a review or approval (ADR-0026).
 */
export function createGithubMergeDelivery(client: GithubRestClient): MergeDeliveryReader {
  async function read(path: string): Promise<unknown> {
    const result = await client.request({ method: "GET", path });
    if (result.kind !== "ok") throw new DeliveryError(result.code);
    return result.json;
  }
  function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new DeliveryError(code);
    return parsed.data;
  }
  async function readAll(path: string, visit: (page: unknown) => boolean): Promise<void> {
    const pages = await client.readPages(path, (page): PageVisit =>
      visit(page) ? "continue" : "invalid",
    );
    if (pages.kind !== "complete") {
      throw new DeliveryError(pages.kind === "failed" ? pages.code : "INCOMPLETE_LISTING");
    }
  }
  const repoPath = (repository: string): string => `repos/${repository}`;

  return {
    async pull(repository, number) {
      const p = parse(
        pullSchema,
        await read(`${repoPath(repository)}/pulls/${String(number)}`),
        "INVALID_PR_RESPONSE",
      );
      if (
        p.number !== number ||
        p.head.repo?.full_name !== repository ||
        p.base.repo.full_name !== repository ||
        p.html_url !== `https://github.com/${repository}/pull/${String(number)}`
      ) {
        throw new DeliveryError("PR_IDENTITY_MISMATCH");
      }
      // A state GitHub adds later, or none yet, is not a reason to merge.
      const reported = mergeableStateSchema.safeParse(p.mergeable_state);
      return {
        number: p.number,
        repository,
        state: p.state,
        merged: p.merged,
        headSha: p.head.sha,
        baseRef: p.base.ref,
        author: p.user.login,
        mergeableState: p.draft === true ? "draft" : reported.success ? reported.data : "unknown",
        // On an open PR this field is GitHub's test merge, not a merge into the base.
        mergeCommitSha: p.merged ? p.merge_commit_sha : null,
        body: p.body ?? "",
      };
    },

    async issue(repository, number) {
      const value = await read(`${repoPath(repository)}/issues/${String(number)}`);
      const issue = parse(issueSchema, value, "INVALID_ISSUE_RESPONSE");
      if (
        issue.number !== number ||
        issue.html_url !== `https://github.com/${repository}/issues/${String(number)}` ||
        "pull_request" in issue
      ) {
        throw new DeliveryError("ISSUE_IDENTITY_MISMATCH");
      }
      return { number, state: issue.state, body: issue.body ?? "" };
    },

    async branchHead(repository, branch) {
      const value = await read(`${repoPath(repository)}/branches/${encodeURIComponent(branch)}`);
      return parse(branchSchema, value, "INVALID_BRANCH_RESPONSE").commit.sha;
    },

    async branchRules(repository, branch) {
      const rules: BranchRules = { requiredApprovingReviewCount: 0, requiredChecks: [] };
      let approvals = 0;
      const checks = new Set<string>();
      await readAll(
        `${repoPath(repository)}/rules/branches/${encodeURIComponent(branch)}?per_page=100`,
        (page) => {
          const items = z.array(ruleSchema).safeParse(page);
          if (!items.success) return false;
          for (const rule of items.data) {
            if (rule.type === "pull_request") {
              const parameters = pullRequestRule.safeParse(rule.parameters);
              if (!parameters.success) return false;
              approvals = Math.max(approvals, parameters.data.required_approving_review_count);
            }
            if (rule.type === "required_status_checks") {
              const parameters = statusChecksRule.safeParse(rule.parameters);
              if (!parameters.success) return false;
              for (const check of parameters.data.required_status_checks) checks.add(check.context);
            }
          }
          return true;
        },
      );
      return { ...rules, requiredApprovingReviewCount: approvals, requiredChecks: [...checks] };
    },

    async checks(repository, sha) {
      // Check runs: the latest run per name (re-runs supersede earlier runs).
      const runs = new Map<string, { id: number; observed: CheckObservations[number] }>();
      await readAll(`${repoPath(repository)}/commits/${sha}/check-runs?per_page=100`, (page) => {
        const parsed = checkRunPage.safeParse(page);
        if (!parsed.success) return false;
        for (const run of parsed.data.check_runs) {
          const previous = runs.get(run.name);
          if (previous !== undefined && previous.id > run.id) continue;
          runs.set(run.name, {
            id: run.id,
            observed: { name: run.name, headSha: run.head_sha, status: runStatus(run) },
          });
        }
        return true;
      });
      // Commit statuses arrive newest first: the first one per context is the current one.
      const statuses = new Map<string, CheckObservations[number]>();
      await readAll(`${repoPath(repository)}/commits/${sha}/statuses?per_page=100`, (page) => {
        const parsed = statusPage.safeParse(page);
        if (!parsed.success) return false;
        for (const status of parsed.data) {
          if (statuses.has(status.context)) continue;
          statuses.set(status.context, {
            name: status.context,
            headSha: sha,
            status: contextStatus(status.state),
          });
        }
        return true;
      });
      return [...[...runs.values()].map((run) => run.observed), ...statuses.values()];
    },

    async nativeReviews(repository, number) {
      const reviews: NativeReviews[number][] = [];
      await readAll(
        `${repoPath(repository)}/pulls/${String(number)}/reviews?per_page=100`,
        (page) => {
          const parsed = reviewPage.safeParse(page);
          if (!parsed.success) return false;
          for (const review of parsed.data) {
            const state = reviewStateSchema.safeParse(review.state);
            // A review without a commit is an unsubmitted draft; it decides nothing.
            if (!state.success || review.commit_id === null) continue;
            reviews.push({
              // A deleted account is not a reviewer anyone can verify.
              actor: review.user?.login ?? "ghost",
              actorType: review.user?.type ?? "Ghost",
              state: state.data,
              commitSha: review.commit_id,
            });
          }
          return true;
        },
      );
      return reviews;
    },

    async authenticatedActor() {
      return parse(userSchema, await read("user"), "INVALID_USER_RESPONSE").login;
    },

    async commit(repository, sha) {
      const commit = parse(
        commitSchema,
        await read(`${repoPath(repository)}/commits/${sha}`),
        "INVALID_COMMIT_RESPONSE",
      );
      return { sha: commit.sha, parents: commit.parents.map((parent) => parent.sha) };
    },

    async branchContains(repository, branch, sha) {
      const compared = parse(
        compareSchema,
        await read(`${repoPath(repository)}/compare/${sha}...${encodeURIComponent(branch)}`),
        "INVALID_COMPARE_RESPONSE",
      );
      return compared.status === "identical" || compared.status === "ahead";
    },
  };
}

function runStatus(run: {
  status: string;
  conclusion: string | null;
}): "passed" | "failed" | "pending" {
  if (run.status !== "completed") return "pending";
  return run.conclusion === "success" ||
    run.conclusion === "neutral" ||
    run.conclusion === "skipped"
    ? "passed"
    : "failed";
}

function contextStatus(state: string): "passed" | "failed" | "pending" {
  if (state === "success") return "passed";
  return state === "pending" ? "pending" : "failed";
}
