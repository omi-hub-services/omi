export interface Rule {
  readonly type: string;
  readonly parameters?: Record<string, unknown>;
}
export interface Ruleset {
  readonly name: string;
  readonly target: "branch" | "tag";
  readonly enforcement: "active";
  readonly bypass_actors: readonly unknown[];
  readonly conditions: { readonly ref_name: { include: string[]; exclude: string[] } };
  readonly rules: readonly Rule[];
}
export type ObservedRuleset = Omit<Ruleset, "enforcement"> & {
  readonly id: number;
  readonly enforcement: string;
};

const requiredCheck = (checks: readonly string[]): Rule => ({
  type: "required_status_checks",
  parameters: {
    strict_required_status_checks_policy: false,
    required_status_checks: checks.map((context) => ({ context })),
  },
});
const pullRequest = (approvals: number, strict: boolean): Rule => ({
  type: "pull_request",
  parameters: {
    required_approving_review_count: approvals,
    dismiss_stale_reviews_on_push: strict,
    require_code_owner_review: false,
    require_last_push_approval: strict,
    required_review_thread_resolution: false,
  },
});
export const ruleset = (
  name: string,
  target: Ruleset["target"],
  ref: string,
  rules: Rule[],
): Ruleset => ({
  name,
  target,
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { include: [ref], exclude: [] } },
  rules,
});

export function desiredBranchRulesets(
  branches: { integration: string; release: string },
  checks: readonly string[],
  prefix = "omi",
): Ruleset[] {
  return [
    ruleset(`${prefix}-main`, "branch", `refs/heads/${branches.release}`, [
      { type: "deletion" },
      { type: "non_fast_forward" },
      pullRequest(1, true),
      requiredCheck(checks),
    ]),
    ruleset(`${prefix}-develop`, "branch", `refs/heads/${branches.integration}`, [
      { type: "deletion" },
      { type: "non_fast_forward" },
      pullRequest(0, false),
      requiredCheck(checks),
    ]),
  ];
}

const PARAMETER_KEYS: Record<string, readonly string[]> = {
  pull_request: [
    "required_approving_review_count",
    "dismiss_stale_reviews_on_push",
    "require_code_owner_review",
    "require_last_push_approval",
    "required_review_thread_resolution",
  ],
  required_status_checks: ["strict_required_status_checks_policy"],
};

export function projectRule(rule: {
  type: string;
  parameters?: Record<string, unknown> | undefined;
}): Rule {
  const keys = PARAMETER_KEYS[rule.type];
  if (keys === undefined) return { type: rule.type };
  const parameters: Record<string, unknown> = {};
  for (const key of keys)
    if (rule.parameters?.[key] !== undefined) parameters[key] = rule.parameters[key];
  if (rule.type === "required_status_checks") {
    const checks = rule.parameters?.["required_status_checks"];
    parameters["required_status_checks"] = Array.isArray(checks)
      ? checks.flatMap((c: unknown) =>
          c !== null && typeof c === "object" && "context" in c && typeof c.context === "string"
            ? [{ context: c.context }]
            : [],
        )
      : [];
  }
  return { type: rule.type, parameters };
}

/**
 * Returns one failure per missing or weaker rule; stricter protections satisfy verification.
 */
export function effectiveRuleFailures(
  have: readonly Rule[],
  want: readonly Rule[],
  branch: string,
): string[] {
  return want
    .filter((rule) => !have.some((h) => ruleAtLeast(h, rule)))
    .map((rule) => `effective rules on ${branch} lack or weaken ${rule.type}`);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    return items.every((i) => typeof i === "object")
      ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items;
  }
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export interface RulesetStep {
  readonly method: "POST" | "PUT";
  readonly path: string;
  readonly body: Ruleset;
}
export function planRulesets(
  repository: string,
  desired: readonly Ruleset[],
  observed: readonly ObservedRuleset[],
): RulesetStep[] {
  return desired.flatMap((want) => {
    const have = observed.find((r) => r.name === want.name);
    if (have !== undefined && sameJson({ ...have, id: undefined }, want)) return [];
    return [
      {
        method: have === undefined ? ("POST" as const) : ("PUT" as const),
        path: `repos/${repository}/rulesets${have === undefined ? "" : `/${String(have.id)}`}`,
        body: want,
      },
    ];
  });
}
export function rulesetFailures(
  desired: readonly Ruleset[],
  observed: readonly ObservedRuleset[],
): string[] {
  return desired.flatMap((want) => {
    const have = observed.find((r) => r.name === want.name);
    if (have === undefined) return [`ruleset ${want.name} missing`];
    const failures: string[] = [];
    if (
      have.target !== want.target ||
      have.enforcement !== "active" ||
      have.bypass_actors.length > 0 ||
      !sameJson(have.conditions, want.conditions)
    )
      failures.push(`ruleset ${want.name} has weaker enforcement, bypass actors or different refs`);
    return [...failures, ...effectiveRuleFailures(have.rules, want.rules, want.name)];
  });
}

function ruleAtLeast(have: Rule, want: Rule): boolean {
  if (have.type !== want.type) return false;
  return Object.entries(want.parameters ?? {}).every(([key, value]) => {
    const actual = have.parameters?.[key];
    if (typeof value === "boolean") return typeof actual === "boolean" && (!value || actual);
    if (typeof value === "number") return typeof actual === "number" && actual >= value;
    if (key === "required_status_checks" && Array.isArray(value))
      return (
        Array.isArray(actual) &&
        value.every((check: unknown) => actual.some((c: unknown) => sameJson(c, check)))
      );
    return sameJson(actual, value);
  });
}
