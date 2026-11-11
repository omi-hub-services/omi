import { describe, expect, it } from "vitest";
import { contextPacketSchema } from "../../../../src/application/contracts/context.ts";
import type {
  CatalogRule,
  ResolutionCatalog,
} from "../../../../src/application/contracts/resolution-catalog.ts";
import { roleSchema } from "../../../../src/application/contracts/role.ts";
import {
  resolveRoleContext,
  RoleResolutionError,
} from "../../../../src/application/services/resolve-role-context.ts";

const h = (c: string) => c.repeat(64);
const role = roleSchema.parse({
  schema_version: 1,
  id: "developer",
  version: 3,
  title: "Developer",
  description: "Implements.",
  skills: ["tdd", "minimal-change"],
  rules: ["architecture-boundaries"],
});

function catalog(overrides: Partial<ResolutionCatalog> = {}): ResolutionCatalog {
  return {
    roles: [{ definition: role, sha256: h("1") }],
    skills: [
      { id: "tdd", version: "1", sha256: h("a") },
      { id: "minimal-change", version: "2", sha256: h("b") },
      { id: "debugging", version: "1", sha256: h("c") },
    ],
    rules: [
      { id: "architecture-boundaries", version: "1", sha256: h("d"), mandatory: false },
      { id: "project-baseline", version: "4", sha256: h("e"), mandatory: true },
      { id: "style", version: "1", sha256: h("f"), mandatory: false },
    ],
    ...overrides,
  };
}

const ids = (entries: readonly { id: string }[]) => entries.map((entry) => entry.id);

describe("resolveRoleContext", () => {
  it("resolves role skills and rules with version and hash, sorted by id", () => {
    const resolved = resolveRoleContext(catalog(), { role: "developer" });
    expect(resolved.role).toEqual({ id: "developer", version: 3, sha256: h("1") });
    expect(resolved.skills).toEqual([
      { id: "minimal-change", version: "2", sha256: h("b") },
      { id: "tdd", version: "1", sha256: h("a") },
    ]);
    expect(resolved.rules).toEqual([
      { id: "architecture-boundaries", version: "1", sha256: h("d") },
      { id: "project-baseline", version: "4", sha256: h("e") },
    ]);
  });

  it("produces manifests accepted by the context packet contract", () => {
    const resolved = resolveRoleContext(catalog(), { role: "developer" });
    const manifest = contextPacketSchema.shape.skillsManifest;
    expect(manifest.parse(resolved.skills)).toEqual(resolved.skills);
    expect(contextPacketSchema.shape.rulesManifest.parse(resolved.rules)).toEqual(resolved.rules);
  });

  it("is deterministic regardless of input order or repetition", () => {
    const a = resolveRoleContext(catalog(), {
      role: "developer",
      stepSkills: ["debugging", "tdd"],
      stepRules: ["style", "architecture-boundaries"],
    });
    const reversed = catalog();
    const b = resolveRoleContext(
      { ...reversed, skills: [...reversed.skills].reverse(), rules: [...reversed.rules].reverse() },
      {
        role: "developer",
        stepSkills: ["tdd", "debugging", "debugging"],
        stepRules: ["architecture-boundaries", "style"],
      },
    );
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(ids(a.skills)).toEqual(["debugging", "minimal-change", "tdd"]);
    expect(resolveRoleContext(catalog(), { role: "developer" })).toEqual(
      resolveRoleContext(catalog(), { role: "developer" }),
    );
  });

  it("does not load the whole library: unrequested skills and rules stay out", () => {
    const resolved = resolveRoleContext(catalog(), { role: "developer" });
    expect(ids(resolved.skills)).not.toContain("debugging");
    expect(ids(resolved.rules)).not.toContain("style");
  });

  it("changes the recorded hash when the content hash changes", () => {
    const base = catalog();
    const changed = catalog({
      skills: base.skills.map((s) => (s.id === "tdd" ? { ...s, sha256: h("9") } : s)),
    });
    const before = resolveRoleContext(base, { role: "developer" });
    const after = resolveRoleContext(changed, { role: "developer" });
    expect(after.skills.find((s) => s.id === "tdd")?.sha256).toBe(h("9"));
    expect(after).not.toEqual(before);
  });

  describe("unknown references", () => {
    it.each([
      ["role", { role: "ghost" }],
      ["step skill", { role: "developer", stepSkills: ["ghost"] }],
      ["step rule", { role: "developer", stepRules: ["ghost"] }],
      ["excluded rule", { role: "developer", excludedRules: ["ghost"] }],
    ])("rejects an unknown %s", (_name, request) => {
      expect(() => resolveRoleContext(catalog(), request)).toThrow(
        expect.objectContaining({ code: "UNKNOWN_REFERENCE" }) as Error,
      );
    });

    it("rejects a role that references a skill or rule missing from the catalog", () => {
      const broken = catalog({
        roles: [{ definition: { ...role, skills: ["missing"] }, sha256: h("1") }],
      });
      expect(() => resolveRoleContext(broken, { role: "developer" })).toThrow(/unknown skill/);
      const brokenRule = catalog({
        roles: [{ definition: { ...role, rules: ["missing"] }, sha256: h("1") }],
      });
      expect(() => resolveRoleContext(brokenRule, { role: "developer" })).toThrow(/unknown rule/);
    });

    it("rejects a duplicate id in the catalog instead of picking one", () => {
      const dup = catalog();
      const twice = catalog({
        skills: [...dup.skills, { id: "tdd", version: "9", sha256: h("2") }],
      });
      expect(() => resolveRoleContext(twice, { role: "developer" })).toThrow(
        expect.objectContaining({ code: "AMBIGUOUS_CATALOG" }) as Error,
      );
    });
  });

  describe("mandatory gates", () => {
    it("includes mandatory rules even when the role and step do not list them", () => {
      const resolved = resolveRoleContext(catalog(), { role: "developer", stepRules: [] });
      expect(ids(resolved.rules)).toContain("project-baseline");
    });

    it("includes mandatory rules for a role with no rules at all", () => {
      const bare = catalog({
        roles: [{ definition: { ...role, skills: [], rules: [] }, sha256: h("1") }],
      });
      expect(ids(resolveRoleContext(bare, { role: "developer" }).rules)).toEqual([
        "project-baseline",
      ]);
    });

    it("refuses to exclude a mandatory rule", () => {
      const attempt = () =>
        resolveRoleContext(catalog(), { role: "developer", excludedRules: ["project-baseline"] });
      expect(attempt).toThrow(RoleResolutionError);
      expect(attempt).toThrow(expect.objectContaining({ code: "MANDATORY_RULE_DROPPED" }) as Error);
    });

    it("can still exclude an optional rule", () => {
      const resolved = resolveRoleContext(catalog(), {
        role: "developer",
        excludedRules: ["architecture-boundaries"],
      });
      expect(ids(resolved.rules)).toEqual(["project-baseline"]);
    });

    it("keeps a mandatory rule that is also listed explicitly", () => {
      const rules: CatalogRule[] = [...catalog().rules];
      const resolved = resolveRoleContext(catalog({ rules }), {
        role: "developer",
        stepRules: ["project-baseline"],
      });
      expect(ids(resolved.rules).filter((id) => id === "project-baseline")).toHaveLength(1);
    });
  });
});
