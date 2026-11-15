import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createProjectInstallation } from "../../src/infrastructure/config/install-project-package.ts";
import { installProjectTool } from "../../src/application/use-cases/project/install-project-tool.ts";

it("installs an editable settings example and preserves gitignore and local settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omi-settings-install-"));
  const root = resolve(import.meta.dirname, "../..");
  try {
    await writeFile(
      join(dir, ".gitignore"),
      "# existing\n/.omi/omisetting.local.json\n!/.omi/omisetting.local.json\n",
    );
    const installation = createProjectInstallation({
      sourceRoot: root,
      provision: async (source, tool) => {
        await mkdir(join(tool, "node_modules"), { recursive: true });
        await symlink(source, join(tool, "node_modules/omi-squad"), "dir");
        await writeFile(join(tool, "package.json"), "{}");
        await writeFile(join(tool, "package-lock.json"), "{}");
      },
    });
    const input = { projectDir: dir, packageDir: root, distribution: "Ubuntu", apply: true };
    await installProjectTool(installation, input);
    const examplePath = join(dir, ".omi/omisetting.example.json");
    const example = await readFile(examplePath, "utf8").catch(() => undefined);
    expect(example).toBeDefined();
    expect(example).toContain('"version": 1');
    const ignore = await readFile(join(dir, ".gitignore"), "utf8");
    expect(ignore).toContain("# existing\n");
    expect(ignore.trimEnd().split("\n").at(-1)).toBe("/.omi/omisetting.local.json");
    if (example === undefined) throw new Error("missing settings example");
    await writeFile(join(dir, ".omi/omisetting.local.json"), example);
    await writeFile(examplePath, "user example");
    await installProjectTool(installation, input);
    expect(await readFile(examplePath, "utf8")).toBe("user example");
    expect(await readFile(join(dir, ".omi/omisetting.local.json"), "utf8")).toBe(example);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(ignore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
