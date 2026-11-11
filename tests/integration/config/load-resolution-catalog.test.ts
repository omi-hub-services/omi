import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CatalogLoadError,
  loadResolutionCatalog,
} from "../../../src/infrastructure/config/load-resolution-catalog.ts";
import { resolveRoleContext } from "../../../src/application/services/resolve-role-context.ts";

const shipped = join(import.meta.dirname, "../../../templates/project/.omi-squad");
const temps: string[] = [];

function copyTemplate(): string {
  const dir = mkdtempSync(join(tmpdir(), "omi-catalog-"));
  temps.push(dir);
  cpSync(shipped, dir, { recursive: true });
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("shipped role and rule templates", () => {
  const catalog = loadResolutionCatalog(shipped);

  it("load, and every role resolves against the curated skills and rules", () => {
    expect(catalog.roles.map((r) => r.definition.id)).toEqual([
      "analyst",
      "architect",
      "designer",
      "developer",
      "qa",
      "reviewer",
    ]);
    for (const { definition } of catalog.roles) {
      const resolved = resolveRoleContext(catalog, { role: definition.id });
      expect(resolved.skills.length).toBeGreaterThan(0);
      expect(resolved.rules.map((r) => r.id)).toEqual(
        expect.arrayContaining(["project-baseline", "approval-gates"]),
      );
      for (const entry of [...resolved.skills, ...resolved.rules]) {
        expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it("does not hand every role the whole library", () => {
    const designer = resolveRoleContext(catalog, { role: "designer" });
    expect(designer.skills.length).toBeLessThan(catalog.skills.length);
    expect(designer.skills.map((s) => s.id)).not.toContain("test-driven-development");
  });

  it("gives the same result on repeated loads", () => {
    expect(resolveRoleContext(loadResolutionCatalog(shipped), { role: "developer" })).toEqual(
      resolveRoleContext(catalog, { role: "developer" }),
    );
  });
});

describe("loadResolutionCatalog failures", () => {
  it("rejects a skill file that differs from the provenance lock", () => {
    const dir = copyTemplate();
    writeFileSync(join(dir, "skills/minimal-change/SKILL.md"), "tampered\n");
    expect(() => loadResolutionCatalog(dir)).toThrow(CatalogLoadError);
  });

  it("rejects a role file with a tool or model field", () => {
    const dir = copyTemplate();
    const file = join(dir, "roles/developer.yaml");
    writeFileSync(file, `${readFileSync(file, "utf8")}model: some-model\n`);
    expect(() => loadResolutionCatalog(dir)).toThrow(/roles\/developer\.yaml/);
  });

  it("rejects a rule without front matter", () => {
    const dir = copyTemplate();
    writeFileSync(join(dir, "rules/project-baseline.md"), "# no front matter\n");
    expect(() => loadResolutionCatalog(dir)).toThrow(/front matter/);
  });

  it("records a new hash when a rule's content changes", () => {
    const dir = copyTemplate();
    const before = loadResolutionCatalog(dir).rules.find((r) => r.id === "evidence-and-tests");
    const file = join(dir, "rules/evidence-and-tests.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}- Extra line.\n`);
    const after = loadResolutionCatalog(dir).rules.find((r) => r.id === "evidence-and-tests");
    expect(after?.sha256).not.toBe(before?.sha256);
  });

  it("makes a role that names a missing skill fail at resolution", () => {
    const dir = copyTemplate();
    const file = join(dir, "roles/qa.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("systematic-debugging", "no-such-skill"),
    );
    expect(() => resolveRoleContext(loadResolutionCatalog(dir), { role: "qa" })).toThrow(
      /unknown skill "no-such-skill"/,
    );
  });
});
