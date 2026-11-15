import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileRuleSource,
  loadResolutionCatalog,
} from "../../../src/infrastructure/config/load-resolution-catalog.ts";
import { dispatchStep } from "../../../src/application/use-cases/runs/dispatch-step.ts";
import { dispatchInput, rig } from "../../unit/application/use-cases/runs/run-fakes.ts";

const shipped = resolve(import.meta.dirname, "../../../templates/project/.omi-squad");
const temps: string[] = [];
function copyTemplate(): string {
  const dir = mkdtempSync(join(tmpdir(), "omi-rule-source-"));
  temps.push(dir);
  cpSync(shipped, dir, { recursive: true });
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("file rule source", () => {
  it("serves every shipped rule verbatim with the hash pinned by the catalog", () => {
    for (const rule of loadResolutionCatalog(shipped).rules) {
      const content = createFileRuleSource(shipped).read(rule.id, rule.version);
      expect(content?.sha256).toBe(rule.sha256);
      expect(content?.ruleMd).toBe(readFileSync(join(shipped, "rules", `${rule.id}.md`), "utf8"));
    }
  });

  it("returns undefined for missing rules and unsafe ids", () => {
    const reader = createFileRuleSource(shipped);
    expect(reader.read("missing", "1")).toBeUndefined();
    expect(reader.read("../rules/script-first", "1")).toBeUndefined();
  });

  it("refuses dispatch when rule bytes change after the catalog was resolved", async () => {
    const dir = copyTemplate();
    const catalog = loadResolutionCatalog(dir);
    const path = join(dir, "rules/script-first.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nTAMPERED\n`);
    const r = rig();
    // Use no skills here to isolate the rule source's real bytes and manifest verification.
    const roles = catalog.roles.map((role) => ({
      ...role,
      definition: { ...role.definition, skills: [] },
    }));
    const reader = createFileRuleSource(dir);
    const result = await dispatchStep(
      { ...r.deps, catalog: { ...catalog, roles }, rules: reader },
      dispatchInput(),
    );
    expect(result).toEqual({ ok: false, reason: "RULE_HASH_MISMATCH", detail: "script-first" });
    expect(r.executor.started).toHaveLength(0);
    expect(r.attempts.rows.size).toBe(0);
    expect(r.artifacts.files.size).toBe(0);
  });
});
