import { expect, it } from "vitest";
import {
  desiredBranchRulesets,
  rulesetFailures,
} from "../../../../src/domain/delivery/github-rulesets.js";
import { projectRuleset } from "../../../../src/application/contracts/github-rulesets.js";

it("accepts stronger approvals and additional required checks during verification", () => {
  const desired = desiredBranchRulesets({ integration: "develop", release: "main" }, ["ci"]);
  const observed = desired.map((r, index) => ({
    ...r,
    id: index + 1,
    rules: r.rules.map((rule) => ({
      ...rule,
      ...(rule.parameters === undefined
        ? {}
        : {
            parameters: {
              ...rule.parameters,
              ...(rule.type === "pull_request"
                ? { required_approving_review_count: 2, require_code_owner_review: true }
                : {}),
              ...(rule.type === "required_status_checks"
                ? {
                    required_status_checks: [{ context: "ci" }, { context: "security" }],
                    strict_required_status_checks_policy: true,
                  }
                : {}),
            },
          }),
    })),
  }));
  expect(rulesetFailures(desired, observed)).toEqual([]);
});
it("rejects malformed status check entries without throwing", () => {
  const desired = desiredBranchRulesets({ integration: "develop", release: "main" }, ["ci"])[0];
  expect(() =>
    projectRuleset({
      ...desired,
      id: 1,
      rules: [{ type: "required_status_checks", parameters: { required_status_checks: [null] } }],
    }),
  ).not.toThrow();
});
