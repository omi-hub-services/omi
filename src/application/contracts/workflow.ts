import { z } from "zod";
import { slugSchema } from "./identifiers.js";
import { schemaVersionV1 } from "./schema-version.js";

const workflowStepSchema = z.strictObject({
  id: slugSchema,
  role: slugSchema,
  needs: z.array(slugSchema),
  skills: z.array(slugSchema).default([]),
  rules: z.array(slugSchema).default([]),
  /** Id of a profile declared in models.yaml; it carries the minimum effort. */
  capability_profile: slugSchema,
  output_contract: slugSchema,
});

const workflowGateSchema = z
  .strictObject({
    id: slugSchema,
    before: slugSchema.optional(),
    after: slugSchema.optional(),
    policy: slugSchema,
  })
  .refine((gate) => (gate.before === undefined) !== (gate.after === undefined), {
    message: "a gate sets exactly one of before / after",
  });

/**
 * Workflow template (`.omi-squad/workflows/*.yaml`). Unique step ids and step references are
 * checked here; acyclicity is a workflow-domain rule and is not part of this contract.
 */
export const workflowSchema = z
  .strictObject({
    schema_version: schemaVersionV1,
    id: slugSchema,
    version: z.number().int().positive(),
    selection: z.strictObject({ task_types: z.array(slugSchema).min(1) }),
    quality_policy: slugSchema,
    steps: z.array(workflowStepSchema).min(1),
    gates: z.array(workflowGateSchema).default([]),
  })
  .meta({ title: "omi-squad workflow v1" })
  .superRefine((workflow, ctx) => {
    const ids = new Set<string>();
    workflow.steps.forEach((step, index) => {
      if (ids.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `duplicate step id "${step.id}"`,
        });
      }
      ids.add(step.id);
    });
    workflow.steps.forEach((step, index) => {
      step.needs.forEach((need, needIndex) => {
        if (!ids.has(need)) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", index, "needs", needIndex],
            message: `unknown step "${need}"`,
          });
        }
      });
    });
    workflow.gates.forEach((gate, index) => {
      const target = gate.before ?? gate.after;
      if (target !== undefined && !ids.has(target)) {
        ctx.addIssue({
          code: "custom",
          path: ["gates", index, gate.before === undefined ? "after" : "before"],
          message: `unknown step "${target}"`,
        });
      }
    });
  });
export type Workflow = z.infer<typeof workflowSchema>;
