import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadRuntimeConfig } from "../../../src/infrastructure/config/load-runtime-config.ts";
import { selectExecutor } from "../../../src/application/use-cases/profiles/select-executor.ts";
import type { ExecutorSelectionStore } from "../../../src/application/ports/executor-selection-store.ts";
import { DEFAULT_EFFORT_POLICY } from "../../../src/domain/agents/complexity-policy.ts";
import { EFFORT_POLICY } from "../../../tools/coordinator/coordinator-settings.ts";
import { baseline } from "../../fixtures/github/project-mapping.ts";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function defaultConfig() {
  const squad = await mkdtemp(join(tmpdir(), "omi-default-models-"));
  temps.push(squad);
  await cp(resolve("templates/project/.omi-squad"), squad, { recursive: true });
  await cp(resolve("templates/project/workflows"), join(squad, "workflows"), { recursive: true });
  await writeFile(join(squad, "config/project.yaml"), stringify(baseline));
  return loadRuntimeConfig(squad);
}

it("loads a schema-valid catalog containing exactly the worker policy models and efforts", async () => {
  const { models } = await defaultConfig();
  const declarations = Object.values(models.models);
  const policy = [
    ...Object.values(EFFORT_POLICY.claude).map((entry) => ({ ...entry, executor: "claude-code" })),
    ...Object.values(EFFORT_POLICY.codex).map((entry) => ({ ...entry, executor: "codex" })),
  ];
  expect(declarations.map(({ model }) => model).sort()).toEqual(
    [...new Set(policy.map(({ model }) => model))].sort(),
  );
  for (const entry of policy) {
    const declaration = declarations.find(
      (model) => model.model === entry.model && model.executor === entry.executor,
    );
    expect(declaration?.supported_efforts).toContain(entry.effort);
  }
});

it.each(["claude-code", "codex"] as const)(
  "selects a default %s model for every feature role at every complexity and quality round",
  async (executor) => {
    const { models, workflows } = await defaultConfig();
    const workflow = workflows.byId("feature")?.workflow;
    expect(workflow).toBeDefined();
    if (workflow === undefined) throw new Error("missing feature workflow");
    const store: ExecutorSelectionStore = {
      reserve: (_attempt, choose) =>
        choose([
          {
            revision: 1,
            activeWorkers: 0,
            metadata: {
              profileId: "worker",
              tool: executor,
              authMode: "subscription",
              credentialRef: "/profiles/worker",
              accountGroupId: "worker-account",
              modelAllowlist: Object.values(models.models)
                .filter((model) => model.executor === executor)
                .map((model) => model.model),
              state: "ready",
              lastProbeAt: 100,
              probeTtlMs: 1000,
              maxConcurrency: 1,
              accountGroupMaxConcurrency: 1,
              preference: 0,
            },
          },
        ]),
      settings: () => undefined,
      listSettings: () => [],
      recordResult: () => undefined,
    };
    for (const step of workflow.steps) {
      for (const complexity of ["low", "medium", "high"] as const) {
        for (const round of [1, 2]) {
          const result = selectExecutor(store, {
            attemptId: "attempt",
            stepRunId: "step",
            attemptNumber: round,
            capabilityProfile: step.capability_profile,
            now: 100,
            models,
            task: { workflow: workflow.id, complexity },
            effortPolicy: DEFAULT_EFFORT_POLICY,
            quality: { policy: workflow.quality_policy, step: step.id, steps: [step.id], round },
          });
          expect(result, `${step.role}/${complexity}/round ${String(round)}`).toMatchObject({
            outcome: "selected",
            candidate: { executor },
          });
        }
      }
    }
  },
);
