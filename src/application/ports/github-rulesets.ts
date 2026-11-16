import type { ObservedRuleset, RulesetStep } from "../../domain/delivery/github-rulesets.js";

export interface GithubRulesets {
  access(repository: string): Promise<{ admin: boolean; privateFreeOrg: boolean }>;
  read(repository: string): Promise<ObservedRuleset[]>;
  write(step: RulesetStep): Promise<void>;
}
export class GithubRulesetsError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
