import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../../src/application/use-cases/project/initialize-project.ts";
import { createCodebaseReader } from "../../src/infrastructure/config/codebase-reader.ts";
import { createOnboardingFileStore } from "../../src/infrastructure/config/onboarding-file-store.ts";
import { createOnboardingTemplateSource } from "../../src/infrastructure/config/onboarding-template-source.ts";
import { createProjectConfigStore } from "../../src/infrastructure/config/project-config-store.ts";
import { baseline } from "../fixtures/github/project-mapping.ts";

const fixtures = join(import.meta.dirname, "..", "fixtures", "projects");
const templates = join(import.meta.dirname, "..", "..", "templates", "project", "workflows");
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Copies a fixture repository into a sandbox and wires the real adapters to it. */
async function sandbox(fixture: "empty-repo" | "existing-repo") {
  const root = await mkdtemp(join(tmpdir(), "omi-onboard-"));
  temps.push(root);
  await cp(join(fixtures, fixture), root, { recursive: true });
  await mkdir(join(root, ".omi-squad", "config"), { recursive: true });
  const deps = {
    // Onboarding never touches GitHub; any call is a bug.
    github: {
      inspect: () => Promise.reject(new Error("unexpected GitHub call")),
      owner: () => Promise.reject(new Error("unexpected GitHub call")),
    },
    config: await createProjectConfigStore(join(root, ".omi-squad", "config")),
    onboarding: {
      codebase: await createCodebaseReader(root),
      files: await createOnboardingFileStore(root),
      templates: createOnboardingTemplateSource(templates),
    },
  };
  return { root, deps };
}

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

const request = (variant: "new" | "existing", apply: boolean) => ({
  config: baseline,
  apply,
  source: { kind: "codebase", variant },
});

describe("onboarding a new or existing project", () => {
  it("detects the stack of an existing repository from files that exist", async () => {
    const { deps } = await sandbox("existing-repo");
    const result = await initializeProject(deps, request("existing", false));
    if (result.kind !== "codebase") throw new Error("Expected codebase");
    expect(result.detection).toEqual({
      language: "typescript",
      other_languages: [],
      package_manager: "pnpm",
      commands: { test: "pnpm run test", build: "pnpm run build", lint: "pnpm run lint" },
      evidence: ["package.json", "pnpm-lock.yaml", "tsconfig.json"],
    });
  });

  it("reports an empty repository as unknown instead of guessing a stack", async () => {
    const { deps } = await sandbox("empty-repo");
    const result = await initializeProject(deps, request("new", false));
    if (result.kind !== "codebase") throw new Error("Expected codebase");
    expect(result.detection).toMatchObject({ language: "unknown", commands: {}, evidence: [] });
  });

  it("dry-run reports what would be written and writes nothing", async () => {
    const { root, deps } = await sandbox("existing-repo");
    const before = await tree(root);
    const result = await initializeProject(deps, request("existing", false));
    expect(result).toMatchObject({ status: "preview" });
    if (result.kind !== "codebase") throw new Error("Expected codebase");
    expect(result.files).toEqual([
      { path: ".omi-squad/config/project.yaml", action: "would-create" },
      { path: ".omi-squad/workflows/onboarding-takeover.yaml", action: "would-create" },
      { path: ".omi-squad/config/codebase.yaml", action: "would-create" },
      { path: ".omi-squad/config/onboarding-plan.md", action: "would-create" },
      ...(await deps.onboarding.templates.runtimeFiles())
        .filter((file) => file.path !== ".omi-squad/workflows/onboarding-takeover.yaml")
        .map((file) => ({ path: file.path, action: "would-create" })),
    ]);
    expect(await tree(root)).toEqual(before);
  });

  it("applies the new-project variant and the existing-project variant", async () => {
    const fresh = await sandbox("empty-repo");
    const created = await initializeProject(fresh.deps, request("new", true));
    expect(created).toMatchObject({ status: "applied" });
    expect(await tree(fresh.root)).toEqual(
      [
        ...new Set([
          ".omi-squad/config/codebase.yaml",
          ".omi-squad/config/onboarding-plan.md",
          ".omi-squad/config/project.yaml",
          ".omi-squad/workflows/onboarding-empty-repo.yaml",
          "README.md",
          ...(await fresh.deps.onboarding.templates.runtimeFiles()).map((file) => file.path),
        ]),
      ].sort(),
    );

    const taken = await sandbox("existing-repo");
    await initializeProject(taken.deps, request("existing", true));
    const codebase = await readFile(join(taken.root, ".omi-squad/config/codebase.yaml"), "utf8");
    expect(codebase).toContain('package_manager: "pnpm"');
    expect(codebase).toContain('test: "pnpm run test"');
    const plan = await readFile(join(taken.root, ".omi-squad/config/onboarding-plan.md"), "utf8");
    expect(plan).toContain("Run `pnpm run test` once");
    expect(await tree(taken.root)).toContain(".omi-squad/workflows/onboarding-takeover.yaml");
  });

  it("keeps every existing file byte for byte and reports it as kept", async () => {
    const { root, deps } = await sandbox("existing-repo");
    const workflow = join(root, ".omi-squad", "workflows", "onboarding-takeover.yaml");
    await mkdir(join(root, ".omi-squad", "workflows"), { recursive: true });
    await writeFile(workflow, "# hand-edited by the team\n");
    await writeFile(join(root, ".omi-squad/config/codebase.yaml"), "language: custom\n");
    const readme = await readFile(join(root, "README.md"), "utf8");

    const result = await initializeProject(deps, request("existing", true));
    if (result.kind !== "codebase") throw new Error("Expected codebase");
    expect(Object.fromEntries(result.files.map((file) => [file.path, file.action]))).toEqual({
      ...Object.fromEntries(
        (await deps.onboarding.templates.runtimeFiles()).map((file) => [file.path, "created"]),
      ),
      ".omi-squad/config/project.yaml": "created",
      ".omi-squad/workflows/onboarding-takeover.yaml": "kept",
      ".omi-squad/config/codebase.yaml": "kept",
      ".omi-squad/config/onboarding-plan.md": "created",
    });
    expect(await readFile(workflow, "utf8")).toBe("# hand-edited by the team\n");
    expect(await readFile(join(root, ".omi-squad/config/codebase.yaml"), "utf8")).toBe(
      "language: custom\n",
    );
    expect(await readFile(join(root, "README.md"), "utf8")).toBe(readme);

    // A second apply is idempotent: nothing is created and nothing is replaced.
    const again = await initializeProject(deps, request("existing", true));
    if (again.kind !== "codebase") throw new Error("Expected codebase");
    expect(again.files.every((file) => file.action === "kept")).toBe(true);
  });

  it("never follows a symlink planted at a target or a parent directory", async () => {
    const { root, deps } = await sandbox("empty-repo");
    const outside = await mkdtemp(join(tmpdir(), "omi-outside-"));
    temps.push(outside);
    await symlink(outside, join(root, ".omi-squad", "workflows"));
    await expect(initializeProject(deps, request("new", true))).rejects.toMatchObject({
      code: "INVALID_ONBOARDING_PATH",
    });
    expect(await readdir(outside)).toEqual([]);

    const second = await sandbox("empty-repo");
    await mkdir(join(second.root, ".omi-squad", "workflows"));
    await symlink(
      join(outside, "stolen.yaml"),
      join(second.root, ".omi-squad/workflows/onboarding-empty-repo.yaml"),
    );
    const result = await initializeProject(second.deps, request("new", true));
    if (result.kind !== "codebase") throw new Error("Expected codebase");
    expect(result.files).toContainEqual({
      path: ".omi-squad/workflows/onboarding-empty-repo.yaml",
      action: "kept",
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it("ships workflow templates that validate against the workflow contract", async () => {
    const source = createOnboardingTemplateSource(templates);
    await expect(source.workflow("new")).resolves.toContain("id: onboarding-empty-repo");
    await expect(source.workflow("existing")).resolves.toContain("id: onboarding-takeover");
  });
});
