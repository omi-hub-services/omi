import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps legacy install paths out of source, templates, tests and current documentation", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const legacyPath = [".omi-squad", "/"].join("");
  const hits: string[] = [];
  async function grep(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      const name = relative(root, target);
      if (
        name === "docs/architecture/adr" ||
        name === "docs/superpowers/specs/2026-11-15-omi-dir-settings-docker-design.md"
      )
        continue;
      if (entry.isDirectory()) await grep(target);
      else if ((await readFile(target, "utf8")).includes(legacyPath)) hits.push(name);
      expect(name).not.toContain(legacyPath);
    }
  }
  for (const directory of ["src", "templates", "tests", "docs"]) await grep(join(root, directory));
  expect(hits).toEqual([]);
});
