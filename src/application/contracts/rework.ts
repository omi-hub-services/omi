import { z } from "zod";
import { identifierSchema } from "./identifiers.js";

export const reworkStateSchema = z.strictObject({
  phase: z.enum(["normal", "architect", "assisted", "blocked", "passed"]),
  failedCycles: z.number().int().nonnegative().max(2),
  architectInterventionId: identifierSchema.optional(),
  countedCycleIds: z.array(identifierSchema),
  reopenDecisionIds: z.array(identifierSchema),
});

/** Runtime decisions after verified review/check results, never raw worker instructions.
 * approvalValid and PO decision ids must come from the runtime's approval boundary.
 */
export const recordReworkEventSchema = z.strictObject({
  runId: identifierSchema,
  event: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("cycle_failed"),
      cycleId: identifierSchema,
      kind: z.enum(["quality", "infrastructure", "awaiting_decision"]),
    }),
    z.strictObject({ type: z.literal("gate_passed") }),
    z.strictObject({
      type: z.literal("architect_solution_accepted"),
      interventionId: identifierSchema,
      changesBusinessOrCost: z.boolean(),
      approvalValid: z.boolean(),
    }),
    z.strictObject({ type: z.literal("architect_no_solution") }),
    z.strictObject({ type: z.literal("po_reopened"), poDecisionId: identifierSchema }),
  ]),
});
