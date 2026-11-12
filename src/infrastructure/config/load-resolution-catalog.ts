import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { sha256Schema, slugSchema } from "../../application/contracts/identifiers.js";
import type {
  CatalogEntry,
  CatalogRole,
  CatalogRule,
  ResolutionCatalog,
} from "../../application/contracts/resolution-catalog.js";
import type { RuleSource } from "../../application/ports/rule-source.js";
import { roleSchema, ruleMetadataSchema } from "../../application/contracts/role.js";

export class CatalogLoadError extends Error {
  override readonly name = "CatalogLoadError";
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/** Skill hash rule of ADR-0019: SHA-256 of `<path> <file sha256>\n` lines in the listed order. */
export function aggregateSkillHash(files: readonly { path: string; sha256: string }[]): string {
  return sha256(files.map((file) => `${file.path} ${file.sha256}\n`).join(""));
}

export const skillsLockSchema = z.object({
  skills: z.array(
    z.object({
      id: slugSchema,
      version: z.string().min(1).max(64),
      sha256: sha256Schema,
      files: z.array(z.object({ path: z.string().min(1), sha256: sha256Schema })).min(1),
    }),
  ),
});

function fail(message: string, cause: unknown): never {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  throw new CatalogLoadError(`${message}${detail}`);
}

function listFiles(dir: string, extension: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort();
}

function loadRoles(squadDir: string): CatalogRole[] {
  return listFiles(join(squadDir, "roles"), ".yaml").map((name) => {
    const bytes = readFileSync(join(squadDir, "roles", name));
    try {
      return { definition: roleSchema.parse(parse(bytes.toString("utf8"))), sha256: sha256(bytes) };
    } catch (error) {
      return fail(`invalid role file roles/${name}`, error);
    }
  });
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

function loadRules(squadDir: string): CatalogRule[] {
  return listFiles(join(squadDir, "rules"), ".md").map((name) => {
    const bytes = readFileSync(join(squadDir, "rules", name));
    const match = FRONT_MATTER.exec(bytes.toString("utf8"));
    if (match?.[1] === undefined) throw new CatalogLoadError(`rules/${name} has no front matter`);
    try {
      const meta = ruleMetadataSchema.parse(parse(match[1]));
      return {
        id: meta.id,
        version: String(meta.version),
        sha256: sha256(bytes),
        mandatory: meta.mandatory,
      };
    } catch (error) {
      return fail(`invalid front matter in rules/${name}`, error);
    }
  });
}

function loadSkills(squadDir: string): CatalogEntry[] {
  let lock: z.infer<typeof skillsLockSchema>;
  try {
    const text = readFileSync(join(squadDir, "provenance", "skills.lock.json"), "utf8");
    lock = skillsLockSchema.parse(JSON.parse(text));
  } catch (error) {
    return fail("invalid provenance/skills.lock.json", error);
  }
  return lock.skills.map((skill) => {
    const actualFiles = skill.files.map((file) => ({
      path: file.path,
      sha256: sha256(readFileSync(join(squadDir, file.path))),
    }));
    for (const [index, actual] of actualFiles.entries()) {
      if (actual.sha256 !== skill.files[index]?.sha256) {
        throw new CatalogLoadError(`skill "${skill.id}" file ${actual.path} differs from the lock`);
      }
    }
    if (aggregateSkillHash(actualFiles) !== skill.sha256) {
      throw new CatalogLoadError(`skill "${skill.id}" hash differs from the lock`);
    }
    return { id: skill.id, version: skill.version, sha256: skill.sha256 };
  });
}

/**
 * Reads a `.omi-squad` directory into a catalog. Each role and rule is hashed from its file
 * bytes; each skill is re-hashed from its files and must match the provenance lock, so a stale
 * or edited skill fails loudly instead of resolving with a wrong hash.
 */
export function loadResolutionCatalog(squadDir: string): ResolutionCatalog {
  return {
    roles: loadRoles(squadDir),
    skills: loadSkills(squadDir),
    rules: loadRules(squadDir),
  };
}

/** Re-read installed rule bytes at dispatch; the application checks the resolved catalog hash. */
export function createFileRuleSource(squadDir: string): RuleSource {
  return {
    read(id) {
      if (!slugSchema.safeParse(id).success) return undefined;
      try {
        const bytes = readFileSync(join(squadDir, "rules", `${id}.md`));
        return { sha256: sha256(bytes), ruleMd: bytes.toString("utf8") };
      } catch {
        return undefined;
      }
    },
  };
}
