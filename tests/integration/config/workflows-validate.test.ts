import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { WorkflowValidationResult } from "../../../src/application/contracts/workflow-validation.ts";
import { validateWorkflows } from "../../../src/application/use-cases/project/validate-workflows.ts";
import { runCli } from "../../../src/interfaces/cli/commands/create-program.ts";
import { createCliEnvironment } from "../../../src/bootstrap/container.ts";
import { loadWorkflowValidationCatalog } from "../../../src/infrastructure/config/load-runtime-config.ts";
import { parse } from "yaml";
import { workflowSchema } from "../../../src/application/contracts/workflow.ts";

it.each(["feature", "refactor", "bugfix", "onboarding-empty-repo"])(
  "%s uses one review worker with script checks and verification skills",
  (id) => {
    const workflow = workflowSchema.parse(
      parse(readFileSync(`templates/project/workflows/${id}.yaml`, "utf8")),
    );
    expect(workflow.steps.some((step) => step.id === "verify")).toBe(false);
    const review = workflow.steps.find((step) => step.id === "review");
    expect(review?.skills).toEqual(
      expect.arrayContaining(["independent-review", "verification-before-completion"]),
    );
    expect(review?.rules).toContain("evidence-and-tests");
    expect(review?.required_checks).toContain("project-check");
    expect(
      workflow.gates
        .filter((gate) =>
          ["regression-test", "existing-tests-unchanged", "existing-tests-passing"].includes(
            gate.id,
          ),
        )
        .every((gate) => gate.after === (gate.id === "regression-test" ? "fix" : "review")),
    ).toBe(true);
  },
);

it("bugfix is one fix step, then review, with scope approval before fix", () => {
  const workflow = workflowSchema.parse(
    parse(readFileSync("templates/project/workflows/bugfix.yaml", "utf8")),
  );
  expect(workflow.steps.map((step) => step.id)).toEqual(["fix", "review"]);
  const fix = workflow.steps[0];
  expect(fix).toMatchObject({
    role: "developer",
    output_contract: "implementation-result-v1",
    required_checks: ["project-check"],
    needs: [],
  });
  expect(fix?.skills).toEqual([
    "systematic-debugging",
    "test-driven-development",
    "minimal-change",
  ]);
  expect(workflow.steps[1]?.needs).toEqual(["fix"]);
  expect(workflow.gates).toContainEqual({
    id: "scope-approved",
    before: "fix",
    policy: "approved-business-baseline",
  });
});

it.each(["ui-ux", "onboarding-takeover", "ci-cd"])("%s retains specialist verification", (id) => {
  const workflow = workflowSchema.parse(
    parse(readFileSync(`templates/project/workflows/${id}.yaml`, "utf8")),
  );
  expect(workflow.steps.some((step) => /verify/.test(step.id))).toBe(true);
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omi-validate-"));
  dirs.push(dir);
  const squad = join(dir, ".omi");
  cpSync(resolve("templates/project/.omi"), squad, { recursive: true });
  cpSync(resolve("templates/project/workflows"), join(squad, "workflows"), { recursive: true });
  const run = async (json = true) => {
    let stdout = "";
    let stderr = "";
    const environment = createCliEnvironment({
      socketPath: join(dir, "absent.sock"),
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    const status = await runCli(["workflows", "validate", ...(json ? ["--json"] : [])], {
      ...environment,
      sendCommand: () => {
        throw new Error("offline validation must not use IPC");
      },
      workflows: {
        validate: () => validateWorkflows({ read: () => loadWorkflowValidationCatalog(squad) }),
      },
    });
    return { status, stdout, stderr };
  };
  return { squad, run };
}

it("validates the installed catalog offline without project config or a runtime", async () => {
  const { run } = setup();
  const result = await run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, errors: [] });
});

it("collects broken workflow fields and missing role, rule and skill references with locations", async () => {
  const { squad, run } = setup();
  writeFileSync(
    join(squad, "workflows/broken.yaml"),
    "schema_version: 1\nid: broken\nversion: bad\n",
  );
  const file = join(squad, "workflows/feature.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace("role: developer", "role: absent-role"));
  unlinkSync(join(squad, "rules/evidence-and-tests.md"));
  const roleFile = join(squad, "roles/qa.yaml");
  writeFileSync(
    roleFile,
    readFileSync(roleFile, "utf8").replace("systematic-debugging", "absent-skill"),
  );
  const result = await run();
  expect(result.status).toBe(1);
  const report = JSON.parse(result.stdout) as WorkflowValidationResult;
  expect(report.ok).toBe(false);
  expect(report.errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ file: join(squad, "workflows/broken.yaml"), path: "version" }),
      expect.objectContaining({
        file,
        path: "steps.1.role",
        message: expect.stringContaining("absent-role") as unknown,
      }),
      expect.objectContaining({
        file: roleFile,
        path: expect.stringMatching(/^skills\./) as unknown,
        message: expect.stringContaining("absent-skill") as unknown,
      }),
      expect.objectContaining({
        path: expect.stringMatching(/rules\./) as unknown,
        message: expect.stringContaining("evidence-and-tests") as unknown,
      }),
    ]),
  );
  const text = await run(false);
  expect(text.status).toBe(1);
  expect(text.stderr).toContain("broken.yaml:version");
});

it("reports YAML syntax and invalid role and rule metadata without hiding other files", async () => {
  const { squad, run } = setup();
  writeFileSync(join(squad, "workflows/broken.yaml"), "steps: [\n");
  writeFileSync(join(squad, "roles/developer.yaml"), "version: wrong\n");
  writeFileSync(
    join(squad, "rules/project-baseline.md"),
    "---\nid: project-baseline\nversion: wrong\nmandatory: true\n---\n",
  );
  const result = await run();
  expect(result.status).toBe(1);
  expect((JSON.parse(result.stdout) as WorkflowValidationResult).errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file: join(squad, "workflows/broken.yaml"),
        path: expect.stringContaining("line") as unknown,
      }),
      expect.objectContaining({ file: join(squad, "roles/developer.yaml"), path: "version" }),
      expect.objectContaining({ file: join(squad, "rules/project-baseline.md"), path: "version" }),
    ]),
  );
});

it("locates role reference errors in the source file even when its filename differs from the id", async () => {
  const { squad, run } = setup();
  const source = join(squad, "roles/developer.yaml");
  const file = join(squad, "roles/custom-developer.yaml");
  renameSync(source, file);
  writeFileSync(file, readFileSync(file, "utf8").replace("minimal-change", "absent-skill"));
  const result = await run();
  expect(result.status).toBe(1);
  expect((JSON.parse(result.stdout) as WorkflowValidationResult).errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file,
        path: expect.stringMatching(/^skills\./) as unknown,
        message: expect.stringContaining("absent-skill") as unknown,
      }),
    ]),
  );
});

it("names the workflow step that needs a project check the project does not configure", async () => {
  const { squad, run } = setup();
  mkdirSync(join(squad, "config"), { recursive: true });
  const project = join(squad, "config/project.yaml");
  writeFileSync(project, "schema_version: 1\nchecks:\n  other-check:\n    command: [npm, test]\n");
  const result = await run();
  expect(result.status).toBe(1);
  expect((JSON.parse(result.stdout) as WorkflowValidationResult).errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file: join(squad, "workflows/feature.yaml"),
        path: "steps.1.required_checks",
        message: expect.stringContaining("checks.project-check") as unknown,
      }),
    ]),
  );
  writeFileSync(
    project,
    "schema_version: 1\nchecks:\n  project-check:\n    command: [npm, test]\n",
  );
  const missingRegression = await run();
  expect(missingRegression.status).toBe(1);
  expect((JSON.parse(missingRegression.stdout) as WorkflowValidationResult).errors).toEqual([
    expect.objectContaining({
      file: join(squad, "workflows/bugfix.yaml"),
      path: "gates",
      message: expect.stringContaining("checks.regression-test") as unknown,
    }),
  ]);
  writeFileSync(
    project,
    "schema_version: 1\nchecks:\n  project-check:\n    command: [npm, test]\n  regression-test:\n    command: [npm, run, test:unit, --]\n",
  );
  expect((await run()).status).toBe(0);
});

it("identifies the id field when a workflow id disagrees with its filename", async () => {
  const { squad, run } = setup();
  const file = join(squad, "workflows/mismatched.yaml");
  writeFileSync(file, readFileSync(join(squad, "workflows/feature.yaml"), "utf8"));
  const result = await run();
  expect(result.status).toBe(1);
  expect((JSON.parse(result.stdout) as WorkflowValidationResult).errors).toEqual([
    { file, path: "id", message: "id must match the workflow filename" },
  ]);
});
