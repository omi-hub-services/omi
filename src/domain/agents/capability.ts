/**
 * Capability model (ADR-0016): a step needs a minimum reasoning effort; an executor/model
 * declares the efforts it supports. The domain keeps its own copy of the ordered effort list
 * because it must not import contracts or Zod; the application layer maps the parsed
 * `models.yaml` onto these types, and a unit test pins the list to the contract's.
 * Capability is never inferred from a model name.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function effortRank(effort: Effort): number {
  return EFFORT_LEVELS.indexOf(effort);
}

export interface CapabilityRequirement {
  readonly minEffort: Effort;
}

/** Lowest effort in `supported` that satisfies `requirement`, or `undefined` if none does. */
export function lowestSatisfyingEffort(
  requirement: CapabilityRequirement,
  supported: readonly Effort[],
): Effort | undefined {
  const floor = effortRank(requirement.minEffort);
  return [...supported]
    .filter((effort) => effortRank(effort) >= floor)
    .sort((a, b) => effortRank(a) - effortRank(b))[0];
}
