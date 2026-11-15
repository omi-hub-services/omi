// Synthetic fixtures. Display names intentionally differ from framework logical keys.
import { projectConfigSchema } from "../../../src/application/contracts/project-config.ts";
import type { InspectedProject } from "../../../src/application/contracts/project-initialization.ts";

export const baseline = projectConfigSchema.parse({
  schema_version: 1,
  repository: { owner: "acme", name: "app" },
  project: { owner: "acme", number: 4 },
  branches: { integration: "develop", release: "main" },
  limits: { max_parallel_workers: 2, step_timeout_seconds: 600, max_rework_cycles: 2 },
  effort_policy: { low: "low", medium: "medium", high: "high" },
  policies: { mandatory_approvals: ["release", "deploy"] },
});
export const project: InspectedProject = {
  id: "PVT_sample",
  number: 4,
  title: "Delivery",
  owner: { id: "O_sample", login: "acme", type: "Organization" },
  fields: [
    {
      id: "PVTSSF_state",
      name: "Etape",
      dataType: "SINGLE_SELECT",
      options: [
        { id: "opt-ready", name: "Pret" },
        { id: "opt-done", name: "Termine" },
      ],
    },
    { id: "PVTF_run", name: "Execution", dataType: "TEXT", options: [] },
    { id: "PVTF_date", name: "Due", dataType: "DATE", options: [] },
  ],
};
export const fields = {
  status: {
    field_id: "PVTSSF_state",
    data_type: "SINGLE_SELECT",
    options: { ready: "opt-ready", done: "opt-done" },
  },
  "run-id": { field_id: "PVTF_run", data_type: "TEXT", options: {} },
};
