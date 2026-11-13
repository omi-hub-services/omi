import { z } from "zod";
import type { ReleaseMergeReader } from "../../application/ports/release-merge.js";
import { DeliveryError } from "../../application/ports/pr-delivery.js";
import { createGithubMergeDelivery } from "./github-merge-delivery.js";
import type { GithubRestClient, PageVisit } from "./github-rest-client.js";

const repositorySchema = z.looseObject({
  full_name: z.string(),
  permissions: z.looseObject({ push: z.boolean() }),
});
const protectionSchema = z.looseObject({
  enforce_admins: z.looseObject({ enabled: z.boolean() }),
  required_pull_request_reviews: z
    .looseObject({ required_approving_review_count: z.number().int().min(0) })
    .nullable()
    .optional(),
  required_status_checks: z
    .looseObject({
      contexts: z.array(z.string()),
      checks: z.array(z.looseObject({ context: z.string() })).optional(),
    })
    .nullable()
    .optional(),
  restrictions: z
    .looseObject({
      users: z.array(z.looseObject({ login: z.string() })),
      teams: z.array(z.unknown()),
      apps: z.array(z.unknown()),
    })
    .nullable()
    .optional(),
  lock_branch: z.looseObject({ enabled: z.boolean() }).optional(),
});

/** Native reviews/checks/rulesets have one implementation, shared with task delivery. */
export function createGithubReleaseMergeReader(client: GithubRestClient): ReleaseMergeReader {
  const delivery = createGithubMergeDelivery(client);
  /** A ruleset `update`/`lock_branch` rule stops merges into the branch; unreadable rules refuse. */
  async function blocksMerge(repository: string, branch: string): Promise<boolean> {
    let blocked = false;
    const pages = await client.readPages(
      `repos/${repository}/rules/branches/${encodeURIComponent(branch)}?per_page=100`,
      (page): PageVisit => {
        const items = z.array(z.looseObject({ type: z.string() })).safeParse(page);
        if (!items.success) return "invalid";
        if (items.data.some((rule) => rule.type === "update" || rule.type === "lock_branch"))
          blocked = true;
        return "continue";
      },
    );
    if (pages.kind !== "complete") throw new DeliveryError("RELEASE_RULES_UNAVAILABLE");
    return blocked;
  }
  return {
    ...delivery,
    async releaseRestrictions(repository, branch, actor) {
      const repo = await client.request({ method: "GET", path: `repos/${repository}` });
      if (repo.kind !== "ok") throw new DeliveryError("RELEASE_PERMISSIONS_UNAVAILABLE");
      const permissions = repositorySchema.parse(repo.json);
      if (permissions.full_name !== repository)
        throw new DeliveryError("REPOSITORY_IDENTITY_MISMATCH");
      // Rulesets must be readable in every case; the gate never guesses from nothing.
      const rules = await delivery.branchRules(repository, branch);
      const blocking = await blocksMerge(repository, branch);
      const response = await client.request({
        method: "GET",
        path: `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`,
      });
      // Only a 404 with readable rulesets means "no classic protection"; anything else refuses.
      if (response.kind === "rejected" && response.code === "HTTP_404") {
        return {
          canMerge: permissions.permissions.push && !blocking,
          requiredApprovingReviewCount: rules.requiredApprovingReviewCount,
          requiredChecks: rules.requiredChecks,
        };
      }
      if (response.kind !== "ok") throw new DeliveryError("RELEASE_PROTECTION_UNAVAILABLE");
      const protection = protectionSchema.parse(response.json);
      const restrictions = protection.restrictions;
      // Team/app membership cannot be inferred from push permission. An explicitly allowed
      // user is provable; otherwise refuse rather than guess or request an admin bypass.
      const allowed =
        restrictions == null ||
        restrictions.users.some((user) => user.login.toLowerCase() === actor.toLowerCase());
      return {
        canMerge:
          permissions.permissions.push &&
          allowed &&
          !blocking &&
          protection.lock_branch?.enabled !== true,
        requiredApprovingReviewCount: Math.max(
          rules.requiredApprovingReviewCount,
          protection.required_pull_request_reviews?.required_approving_review_count ?? 0,
        ),
        requiredChecks: [
          ...new Set([
            ...rules.requiredChecks,
            ...(protection.required_status_checks?.contexts ?? []),
            ...(protection.required_status_checks?.checks?.map((check) => check.context) ?? []),
          ]),
        ],
      };
    },
  };
}
