import { z } from "zod";
import {
  projectRule,
  effectiveRuleFailures as compareRules,
  type Rule,
  type ObservedRuleset,
} from "../../domain/delivery/github-rulesets.js";
const rawRulesetSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  target: z.enum(["branch", "tag", "push"]),
  enforcement: z.string(),
  bypass_actors: z.array(z.unknown()).nullish(),
  conditions: z
    .looseObject({
      ref_name: z.looseObject({
        include: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
      }),
    })
    .nullish(),
  rules: z.array(
    z.looseObject({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() }),
  ),
});
/** Reduces a GitHub ruleset response to the fields the framework sets, so defaults never show as drift. */
export function projectRuleset(raw: unknown): ObservedRuleset | undefined {
  const parsed = rawRulesetSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const target = parsed.data.target;
  if (target === "push") return undefined;
  const data = parsed.data;
  const rules = data.rules.map(projectRule);
  return {
    id: data.id,
    name: data.name,
    target,
    enforcement: data.enforcement,
    bypass_actors: data.bypass_actors ?? [],
    conditions: { ref_name: data.conditions?.ref_name ?? { include: [], exclude: [] } },
    rules,
  };
}

export function effectiveRuleFailures(
  raw: unknown,
  want: readonly Rule[],
  branch: string,
): string[] {
  const parsed = z
    .array(
      z.looseObject({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() }),
    )
    .safeParse(raw);
  if (!parsed.success) return [`effective rules on ${branch} could not be read`];
  return compareRules(parsed.data.map(projectRule), want, branch);
}
