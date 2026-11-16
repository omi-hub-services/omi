import { z } from "zod";
import {
  GithubRulesetsError,
  type GithubRulesets,
} from "../../application/ports/github-rulesets.js";
import { projectRuleset } from "../../application/contracts/github-rulesets.js";
import type { ObservedRuleset } from "../../domain/delivery/github-rulesets.js";
import type { GithubRestClient } from "./github-rest-client.js";

const repositorySchema = z.object({
  private: z.boolean(),
  owner: z.object({ type: z.enum(["User", "Organization"]) }),
  permissions: z.object({ admin: z.boolean() }),
});
const planSchema = z.object({ plan: z.object({ name: z.string().min(1) }) });
const listingSchema = z.array(
  z.object({ id: z.number().int().positive(), source_type: z.string().optional() }),
);

export function createGithubRulesets(client: GithubRestClient): GithubRulesets {
  const get = async (path: string): Promise<unknown> => {
    const result = await client.request({ method: "GET", path });
    if (result.kind !== "ok") throw new GithubRulesetsError(result.code);
    return result.json;
  };
  return {
    async access(repository) {
      const parsed = repositorySchema.safeParse(await get(`repos/${repository}`));
      if (!parsed.success) throw new GithubRulesetsError("GITHUB_RULESETS_INVALID_RESPONSE");
      const repo = parsed.data;
      if (!repo.permissions.admin) return { admin: false, privateFreeOrg: false };
      let privateFreeOrg = false;
      if (repo.private && repo.owner.type === "Organization") {
        const plan = planSchema.safeParse(await get(`orgs/${repository.split("/")[0] ?? ""}`));
        if (!plan.success) throw new GithubRulesetsError("GITHUB_RULESETS_PLAN_UNAVAILABLE");
        privateFreeOrg = plan.data.plan.name.toLowerCase() === "free";
      }
      return { admin: repo.permissions.admin, privateFreeOrg };
    },
    async read(repository) {
      const ids: number[] = [];
      const result = await client.readPages(
        `repos/${repository}/rulesets?includes_parents=false&per_page=100`,
        (page) => {
          const parsed = listingSchema.safeParse(page);
          if (!parsed.success) return "invalid";
          ids.push(
            ...parsed.data
              .filter((r) => r.source_type === undefined || r.source_type === "Repository")
              .map((r) => r.id),
          );
          return "continue";
        },
      );
      if (result.kind === "failed") throw new GithubRulesetsError(result.code);
      const rulesets: ObservedRuleset[] = [];
      for (const id of ids) {
        const raw = await get(`repos/${repository}/rulesets/${String(id)}`);
        if (z.object({ target: z.literal("push") }).safeParse(raw).success) continue;
        const ruleset = projectRuleset(raw);
        if (ruleset === undefined)
          throw new GithubRulesetsError("GITHUB_RULESETS_INVALID_RESPONSE");
        rulesets.push(ruleset);
      }
      return rulesets;
    },
    async write(step) {
      const result = await client.request(step);
      if (result.kind !== "ok") throw new GithubRulesetsError(result.code);
    },
  };
}
