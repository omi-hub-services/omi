// Temporary Coordinator policy (OMI-058); inputs are data, never prompt instructions.
export type Complexity = "low" | "medium" | "high";

export interface EffortInput {
  readonly workflow: string | null;
  readonly workType: string | null;
  readonly area: string | null;
  readonly priority: string | null;
  readonly acCount: number;
  readonly labels: readonly string[];
  readonly hasLiveTests?: boolean;
}

export interface EffortDecision {
  readonly complexity: Complexity;
  readonly reason: string;
}

/** Override, missing fields, high-risk work, docs/small non-runtime work, then medium. */
export function inferComplexity(input: EffortInput): EffortDecision {
  // Conflicting overrides choose the higher complexity, independent of label order.
  for (const complexity of ["high", "medium", "low"] as const) {
    if (input.labels.includes(`complexity:${complexity}`)) {
      return { complexity, reason: `label complexity:${complexity}` };
    }
  }
  const fields = {
    Workflow: input.workflow,
    "Work Type": input.workType,
    Area: input.area,
    Priority: input.priority,
  };
  const missing = Object.entries(fields).filter(([, value]) => !value?.trim());
  if (missing.length > 0) {
    return {
      complexity: "medium",
      reason: `missing Project fields: ${missing.map(([name]) => name).join(", ")}; default medium`,
    };
  }
  const workflow = input.workflow?.trim().toLowerCase();
  const workType = input.workType?.trim().toLowerCase();
  const area = input.area?.trim().toLowerCase() ?? "";
  const runtime = ["domain", "runtime", "adapters", "github"].includes(area);
  if (workflow === "research" || workType === "spike" || workType === "poc" || workflow === "poc") {
    return { complexity: "high", reason: "research / Spike / PoC" };
  }
  if (input.hasLiveTests && ["runtime", "adapters", "github"].includes(area)) {
    return { complexity: "high", reason: `${area} with live tests` };
  }
  if (input.priority?.trim().toUpperCase() === "P0" && input.acCount > 5) {
    return { complexity: "high", reason: "P0 with more than 5 top-level AC" };
  }
  if (workflow === "docs" || workType === "docs") {
    return { complexity: "low", reason: "docs workflow / Work Type Docs" };
  }
  if (input.acCount > 0 && input.acCount <= 3 && !runtime) {
    return { complexity: "low", reason: "at most 3 top-level AC in a non-runtime Area" };
  }
  return { complexity: "medium", reason: `${workflow ?? "unknown"} work; default medium` };
}
