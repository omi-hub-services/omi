import type { ProjectConfig } from "../../contracts/project-config.js";
import { GithubRulesetsError, type GithubRulesets } from "../../ports/github-rulesets.js";
import {
  desiredBranchRulesets,
  planRulesets,
  rulesetFailures,
  type RulesetStep,
} from "../../../domain/delivery/github-rulesets.js";

export type RulesetsMode = "dry-run" | "apply" | "verify";
export interface RulesetsResult {
  ok: boolean;
  code?: string;
  failures: string[];
  steps: RulesetStep[];
}
export async function configureGithubRulesets(
  github: GithubRulesets,
  config: ProjectConfig,
  mode: RulesetsMode,
): Promise<RulesetsResult> {
  const repository = `${config.repository.owner}/${config.repository.name}`;
  const checks = Object.keys(config.checks ?? {});
  const refuse = (code: string, message: string): RulesetsResult => ({
    ok: false,
    code,
    failures: [message],
    steps: [],
  });
  if (checks.length === 0)
    return refuse(
      "GITHUB_RULESETS_CHECK_UNCONFIGURED",
      "Configure checks in .omi/config/project.yaml before setting branch rulesets",
    );
  try {
    if (mode === "apply") {
      const access = await github.access(repository);
      if (!access.admin)
        return refuse(
          "GITHUB_RULESETS_ADMIN_REQUIRED",
          "The gh account needs repository admin permission to apply rulesets",
        );
      if (access.privateFreeOrg)
        return refuse(
          "GITHUB_RULESETS_PRIVATE_FREE_ORG",
          "Rulesets are not enforced on private repositories owned by a Free-plan organization",
        );
    }
    const desired = desiredBranchRulesets(config.branches, checks);
    const observed = await github.read(repository);
    const steps = planRulesets(repository, desired, observed);
    if (mode === "verify") {
      const failures = rulesetFailures(desired, observed);
      return { ok: failures.length === 0, failures, steps: [] };
    }
    if (mode === "apply") for (const step of steps) await github.write(step);
    return { ok: true, failures: [], steps };
  } catch (error) {
    if (!(error instanceof GithubRulesetsError)) throw error;
    return refuse(error.code, `GitHub rulesets could not be processed (${error.code})`);
  }
}
