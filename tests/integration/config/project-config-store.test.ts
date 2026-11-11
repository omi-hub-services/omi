import { mkdtemp, readFile, readdir, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { initializeProject } from "../../../src/application/use-cases/project/initialize-project.ts";
import { createProjectConfigStore } from "../../../src/infrastructure/config/project-config-store.ts";
import { baseline, fields, project } from "../../fixtures/github/project-mapping.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omi-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const request = {
  config: baseline,
  source: { kind: "existing", project: baseline.project, fields },
};
const github = {
  inspect: () => Promise.resolve(project),
  owner: () => Promise.resolve(project.owner),
};

describe("create-only project.yaml", () => {
  it("preview writes nothing; explicit apply publishes complete validated YAML", async () => {
    const config = await createProjectConfigStore(dir);
    const preview = await initializeProject({ github, config }, request);
    expect(preview.status).toBe("preview");
    expect(await readdir(dir)).toEqual([]);
    expect((await initializeProject({ github, config }, { ...request, apply: true })).status).toBe(
      "applied",
    );
    expect(await config.read()).toMatchObject({
      ...baseline,
      project: { mapping: { id: project.id, fields } },
    });
    expect((await stat(join(dir, "project.yaml"))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["project.yaml"]);
  });

  it("never overwrites existing config, preserving bytes, comments, policies and branches", async () => {
    const bytes = `# hand-maintained configuration\n${stringify({ ...baseline, branches: { integration: "integration", release: "release" } })}`;
    const path = join(dir, "project.yaml");
    await writeFile(path, bytes);
    const config = await createProjectConfigStore(dir);
    const result = await initializeProject({ github, config }, { ...request, apply: true });
    expect(result).toMatchObject({
      status: "config-exists",
      proposed: { branches: { integration: "integration", release: "release" } },
    });
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect(await config.create(baseline)).toBe("exists");
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it("two competing publications produce one winner, preserve its bytes and leave no temp files", async () => {
    const first = await createProjectConfigStore(dir);
    const second = await createProjectConfigStore(dir);
    const other = { ...baseline, repository: { owner: "other", name: "app" } };
    const outcomes = await Promise.all([first.create(baseline), second.create(other)]);
    expect([...outcomes].sort()).toEqual(["created", "exists"]);
    expect(await first.read()).toEqual(outcomes[0] === "created" ? baseline : other);
    expect(await readdir(dir)).toEqual(["project.yaml"]);
  });

  it("a destination created between preview read and apply is preserved", async () => {
    const config = await createProjectConfigStore(dir);
    const path = join(dir, "project.yaml");
    const racedStore = {
      ...config,
      read: async () => {
        await writeFile(path, "# concurrent writer\n");
        return undefined;
      },
    };
    const result = await initializeProject(
      { github, config: racedStore },
      { ...request, apply: true },
    );
    expect(result.status).toBe("config-exists");
    expect(await readFile(path, "utf8")).toBe("# concurrent writer\n");
  });

  it("preserves symlinks and refuses to read their target", async () => {
    const target = join(dir, "target.yaml");
    await writeFile(target, "unchanged");
    await symlink(target, join(dir, "project.yaml"));
    const config = await createProjectConfigStore(dir);
    expect(await config.create(baseline)).toBe("exists");
    await expect(config.read()).rejects.toMatchObject({ code: "CONFIG_UNREADABLE" });
    expect(await readFile(target, "utf8")).toBe("unchanged");
  });

  it.each([
    "schema_version: 1\nschema_version: 1\n",
    "repository: !unsafe tagged\n",
    "a: &anchor [a,b]\nb: *anchor\n",
    "schema_version: 99\n",
    "not: [yaml",
    "x".repeat(1024 * 1024 + 1),
  ])("rejects invalid, ambiguous or oversized config without modifying bytes", async (bytes) => {
    const path = join(dir, "project.yaml");
    await writeFile(path, bytes);
    const config = await createProjectConfigStore(dir);
    await expect(
      initializeProject({ github, config }, { ...request, apply: true }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect(await readdir(dir)).toEqual(["project.yaml"]);
  });
  it("round-trips the configured task effort mapping in project.yaml", async () => {
    const config = await createProjectConfigStore(dir);
    const effort_policy = { low: "medium", medium: "high", high: "max" } as const;
    await config.create({ ...baseline, effort_policy });
    expect(await config.read()).toMatchObject({ effort_policy });
    expect(await readFile(join(dir, "project.yaml"), "utf8")).toContain("high: max");
  });
});
