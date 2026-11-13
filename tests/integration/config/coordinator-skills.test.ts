import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProjectInstallation } from "../../../src/infrastructure/config/install-project-package.ts";
import { installProjectTool } from "../../../src/application/use-cases/project/install-project-tool.ts";
import { loadResolutionCatalog } from "../../../src/infrastructure/config/load-resolution-catalog.ts";
import { createFileSkillSource } from "../../../src/infrastructure/config/file-skill-source.ts";
import { resolveRoleContext } from "../../../src/application/services/resolve-role-context.ts";
import { buildClaudeInvocationArgs } from "../../../src/infrastructure/executors/claude-code/claude-code-invocation.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});
it("installs Coordinator skills through the managed bridge and preserves edits on reapply", async () => {
  const temp = await mkdtemp(join(tmpdir(), "omi-coordinator-skills-"));
  temporary.push(temp);
  const pkg = join(temp, "package");
  const projectDir = join(temp, "project");
  for (const path of [projectDir, join(pkg, "dist"), join(pkg, "schemas")])
    await mkdir(path, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "omi-squad", version: "0.0.0" }),
  );
  await cp(resolve("templates"), join(pkg, "templates"), { recursive: true });
  await cp(resolve("migrations"), join(pkg, "migrations"), { recursive: true });
  const store = createProjectInstallation({
    sourceRoot: resolve("."),
    provision: async (source, tool) => {
      await mkdir(join(tool, "node_modules"), { recursive: true });
      await symlink(source, join(tool, "node_modules", "omi-squad"));
    },
  });
  const input = { projectDir, packageDir: pkg, distribution: "Ubuntu", apply: true };
  expect((await installProjectTool(store, input)).status).toBe("installed");
  for (const id of ["omi-status", "omi-next", "omi-watch"]) {
    const path = join(projectDir, `.claude/skills/${id}/SKILL.md`);
    const text = await readFile(path, "utf8").catch(() => "MISSING");
    expect(text).toContain(`name: ${id}`);
    expect(text).not.toContain("tools/coordinator");
    expect(text).toContain(".omi-squad/bin/omi");
    await writeFile(path, `${text}\nUser edits\n`);
    expect((await installProjectTool(store, input)).status).toBe("installed");
    expect(await readFile(path, "utf8")).toBe(`${text}\nUser edits\n`);
  }
  const lock = await readFile(join(projectDir, ".omi-squad/provenance/skills.lock.json"), "utf8");
  expect(lock).not.toMatch(/omi-(?:status|next|watch)/);
  const squad = join(projectDir, ".omi-squad");
  const catalog = loadResolutionCatalog(squad);
  for (const role of catalog.roles) {
    const context = resolveRoleContext(catalog, { role: role.definition.id });
    for (const id of ["omi-status", "omi-next", "omi-watch"])
      expect(context.skills.map((skill) => skill.id)).not.toContain(id);
  }
  for (const id of ["omi-status", "omi-next", "omi-watch"])
    expect(createFileSkillSource(squad).read(id, "1")).toBeUndefined();
  const args = buildClaudeInvocationArgs({
    model: "worker",
    effort: "medium",
    access: "workspace-write",
  });
  expect(args).toContain("--disable-slash-commands");
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("project,local");
}, 30_000);
