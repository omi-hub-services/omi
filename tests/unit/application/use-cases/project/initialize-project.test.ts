import { describe, expect, it, vi } from "vitest";
import { initializeProject } from "../../../../../src/application/use-cases/project/initialize-project.ts";
import { inspectProject } from "../../../../../src/application/use-cases/project/inspect-project.ts";
import { previewProjectConfig } from "../../../../../src/application/services/preview-project-config.ts";
import type { ProjectConfig } from "../../../../../src/application/contracts/project-config.ts";
import type { InspectedProject } from "../../../../../src/application/contracts/project-initialization.ts";
import { baseline, fields, project } from "../../../../fixtures/github/project-mapping.ts";

const input = {
  config: baseline,
  source: { kind: "existing", project: { owner: "acme", number: 4 }, fields },
};
const templateInput = {
  config: baseline,
  source: {
    kind: "template",
    template: { owner: "acme", number: 4 },
    owner: "acme",
    title: "Delivery",
    operationKey: "init-app",
  },
};
function setup(existing?: ProjectConfig, remote: InspectedProject = project) {
  const create = vi.fn(() => Promise.resolve("created" as const));
  return {
    config: { read: vi.fn(() => Promise.resolve(existing)), create },
    github: {
      inspect: vi.fn(() => Promise.resolve(remote)),
      owner: vi.fn(() => Promise.resolve(remote.owner)),
    },
  };
}

describe("Project discovery and initialization", () => {
  it.each(["Organization", "User"] as const)(
    "detects %s and maps IDs despite renamed display labels",
    async (type) => {
      const deps = setup(undefined, {
        ...project,
        owner: { ...project.owner, type },
        fields: project.fields.map((field) => ({
          ...field,
          name: "Renamed",
          options: field.options.map((option) => ({ ...option, name: "Renamed option" })),
        })),
      });
      const result = await initializeProject(deps, input);
      expect(result).toMatchObject({
        kind: "mapping",
        status: "preview",
        proposed: { project: { mapping: { id: project.id, owner_type: type, fields } } },
      });
      expect(deps.config.create).not.toHaveBeenCalled();
      if (result.kind !== "mapping") throw new Error("Expected mapping");
      expect(result.changes).toContainEqual({
        path: "project.mapping.fields.status.options.ready",
        after: "opt-ready",
      });
    },
  );

  it("writes only with explicit apply, including real project ID and field IDs", async () => {
    const deps = setup();
    const result = await initializeProject(deps, { ...input, apply: true });
    expect(result.status).toBe("applied");
    expect(deps.config.create).toHaveBeenCalledWith(
      expect.objectContaining({
        project: {
          owner: "acme",
          number: 4,
          mapping: { id: project.id, owner_type: "Organization", fields },
        },
      }),
    );
  });

  it("returns a merge preview and preserves existing policies and branch settings even on apply", async () => {
    const current = {
      ...baseline,
      branches: { integration: "integration", release: "release" },
      limits: { ...baseline.limits, max_parallel_workers: 7 },
    };
    const deps = setup(current);
    const result = await initializeProject(deps, { ...input, apply: true });
    expect(result).toMatchObject({
      kind: "mapping",
      status: "config-exists",
      proposed: { branches: current.branches, limits: current.limits, policies: current.policies },
    });
    expect(deps.config.create).not.toHaveBeenCalled();
  });

  it("preserves unrelated mappings only for the same project ID", async () => {
    const current: ProjectConfig = {
      ...baseline,
      project: {
        ...baseline.project,
        mapping: {
          id: project.id,
          owner_type: "Organization",
          fields: { date: { field_id: "PVTF_date", data_type: "DATE", options: {} } },
        },
      },
    };
    const result = await initializeProject(setup(current), input);
    expect(result).toMatchObject({
      proposed: {
        project: { mapping: { fields: { date: { field_id: "PVTF_date" }, ...fields } } },
      },
    });
    const switched = await initializeProject(
      setup({
        ...current,
        project: {
          ...current.project,
          mapping: {
            ...current.project.mapping,
            id: "PVT_other",
            owner_type: "Organization",
            fields: current.project.mapping?.fields ?? {},
          },
        },
      }),
      input,
    );
    if (switched.kind !== "mapping") throw new Error("Expected mapping");
    expect(switched.proposed.project.mapping?.fields).toEqual(fields);
  });

  it("reports a create race as config-exists", async () => {
    const deps = setup();
    const result = await initializeProject(
      { ...deps, config: { ...deps.config, create: () => Promise.resolve("exists") } },
      { ...input, apply: true },
    );
    expect(result.status).toBe("config-exists");
  });

  it.each([
    [{ field_id: "PVTSSF_unknown", data_type: "SINGLE_SELECT", options: {} }, "FIELD_NOT_FOUND"],
    [{ field_id: "PVTSSF_state", data_type: "TEXT", options: {} }, "FIELD_TYPE_MISMATCH"],
    [
      {
        field_id: "PVTSSF_state",
        data_type: "SINGLE_SELECT",
        options: { ready: "other-field-option" },
      },
      "OPTION_NOT_FOUND",
    ],
    [
      { field_id: "PVTF_run", data_type: "TEXT", options: { ready: "opt-ready" } },
      "OPTIONS_REQUIRE_SINGLE_SELECT",
    ],
    [
      {
        field_id: "PVTSSF_state",
        data_type: "SINGLE_SELECT",
        options: { ready: "opt-ready", done: "opt-ready" },
      },
      "DUPLICATE_OPTION_MAPPING",
    ],
  ])("refuses invalid mapping without a write: %s", async (mapping, code) => {
    const deps = setup();
    await expect(
      initializeProject(deps, {
        ...input,
        apply: true,
        source: { ...input.source, fields: { status: mapping } },
      }),
    ).rejects.toMatchObject({ code });
    expect(deps.config.create).not.toHaveBeenCalled();
  });

  it("refuses field ID reuse under two logical keys", async () => {
    await expect(
      initializeProject(setup(), {
        ...input,
        source: { ...input.source, fields: { a: fields.status, b: fields.status } },
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_FIELD_MAPPING" });
  });

  it("rejects unknown input keys and non-boolean apply before I/O", async () => {
    const deps = setup();
    await expect(initializeProject(deps, { ...input, apply: "yes" })).rejects.toThrow();
    await expect(initializeProject(deps, { ...input, overwrite: true })).rejects.toThrow();
    expect(deps.config.read).not.toHaveBeenCalled();
  });

  it("refuses wrong project identity, duplicate remote field IDs and option IDs", async () => {
    for (const remote of [
      { ...project, number: 5 },
      { ...project, owner: { ...project.owner, login: "wrong" } },
      { ...project, fields: [...project.fields, ...project.fields] },
      {
        ...project,
        fields: [
          {
            id: "PVTSSF_x",
            name: "x",
            dataType: "SINGLE_SELECT",
            options: [
              { id: "same", name: "a" },
              { id: "same", name: "b" },
            ],
          },
        ],
      },
    ])
      await expect(
        inspectProject(setup(undefined, remote).github, input.source.project),
      ).rejects.toThrow();
  });

  it("previews a template copy without outbox or config writes", async () => {
    const deps = setup();
    const result = await initializeProject(deps, templateInput);
    expect(result).toMatchObject({
      kind: "template",
      status: "preview",
      operation: { type: "project.copy", ownerId: "O_sample", sourceProjectId: project.id },
      next: "inspect-copy-and-map-ids",
    });
    expect(deps.config.create).not.toHaveBeenCalled();
  });

  it("refuses a template copy with existing config or without durable queue dependencies", async () => {
    expect(
      await initializeProject(setup(baseline), { ...templateInput, apply: true }),
    ).toMatchObject({ status: "config-exists" });
    await expect(
      initializeProject(setup(), { ...templateInput, apply: true }),
    ).rejects.toMatchObject({ code: "TEMPLATE_QUEUE_REQUIRED" });
  });

  it("diffs removed values and treats arrays atomically with stable ordering", () => {
    const after = {
      ...baseline,
      policies: { mandatory_approvals: ["release"] },
      project: {
        ...baseline.project,
        mapping: { id: project.id, owner_type: "User" as const, fields: {} },
      },
    };
    const changes = previewProjectConfig(after, baseline);
    expect(changes).toEqual([
      { path: "policies.mandatory_approvals", before: ["release"], after: ["release", "deploy"] },
      { path: "project.mapping", before: after.project.mapping },
    ]);
    expect(previewProjectConfig(baseline, baseline)).toEqual([]);
  });
});
