import type { WorkflowValidationSource } from "../../ports/workflow-catalog.js";
import type { WorkflowValidationResult } from "../../contracts/workflow-validation.js";
import { validateCatalogReferences } from "../../services/resolve-role-context.js";

export async function validateWorkflows(
  source: WorkflowValidationSource,
): Promise<WorkflowValidationResult> {
  const loaded = await source.read();
  const errors = [...loaded.errors];
  for (const { definition, file } of loaded.roles) {
    errors.push(
      ...validateCatalogReferences(loaded.catalog, [
        ...definition.skills.map((id, index) => ({
          kind: "skill" as const,
          id,
          path: `skills.${String(index)}`,
        })),
        ...definition.rules.map((id, index) => ({
          kind: "rule" as const,
          id,
          path: `rules.${String(index)}`,
        })),
      ]).map((error) => ({ file, ...error })),
    );
  }
  for (const { workflow, file } of loaded.workflows) {
    workflow.steps.forEach((step, index) => {
      // A required check without a command would fail every dispatch (CHECK_UNCONFIGURED).
      for (const id of step.required_checks) {
        if (loaded.configuredChecks === undefined || loaded.configuredChecks.includes(id)) continue;
        errors.push({
          file,
          path: `steps.${String(index)}.required_checks`,
          message: `step "${step.id}" requires check "${id}" but project.yaml has no checks.${id}`,
        });
      }
      errors.push(
        ...validateCatalogReferences(loaded.catalog, [
          { kind: "role", id: step.role, path: `steps.${String(index)}.role` },
          ...step.skills.map((id, i) => ({
            kind: "skill" as const,
            id,
            path: `steps.${String(index)}.skills.${String(i)}`,
          })),
          ...step.rules.map((id, i) => ({
            kind: "rule" as const,
            id,
            path: `steps.${String(index)}.rules.${String(i)}`,
          })),
        ]).map((error) => ({ file, ...error })),
      );
    });
  }
  return { ok: errors.length === 0, errors };
}
