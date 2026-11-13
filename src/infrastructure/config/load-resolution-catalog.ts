import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigYaml, configDiagnostics } from "./config-diagnostics.js";
import type { ConfigValidationError } from "../../application/contracts/workflow-validation.js";
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
  throw new CatalogLoadError(`${message}${detail}`, { cause });
}

function collect<T>(file: string, load: () => T, errors?: ConfigValidationError[]): T[] {
  try {
    return [load()];
  } catch (error) {
    if (errors === undefined) throw error;
    errors.push(...configDiagnostics(file, error));
    return [];
  }
}

function listFiles(dir: string, extension: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort();
}

function loadRoles(
  squadDir: string,
  errors?: ConfigValidationError[],
  roleFiles?: Map<CatalogRole, string>,
): CatalogRole[] {
  return listFiles(join(squadDir, "roles"), ".yaml").flatMap((name) =>
    collect(
      join(squadDir, "roles", name),
      () => {
        const bytes = readFileSync(join(squadDir, "roles", name));
        try {
          const role = {
            definition: roleSchema.parse(parseConfigYaml(bytes.toString("utf8"))),
            sha256: sha256(bytes),
          };
          roleFiles?.set(role, join(squadDir, "roles", name));
          return role;
        } catch (error) {
          return fail(`invalid role file roles/${name}`, error);
        }
      },
      errors,
    ),
  );
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

function loadRules(squadDir: string, errors?: ConfigValidationError[]): CatalogRule[] {
  return listFiles(join(squadDir, "rules"), ".md").flatMap((name) =>
    collect(
      join(squadDir, "rules", name),
      () => {
        const bytes = readFileSync(join(squadDir, "rules", name));
        const match = FRONT_MATTER.exec(bytes.toString("utf8"));
        if (match?.[1] === undefined)
          throw new CatalogLoadError(`rules/${name} has no front matter`);
        try {
          const meta = ruleMetadataSchema.parse(parseConfigYaml(match[1]));
          return {
            id: meta.id,
            version: String(meta.version),
            sha256: sha256(bytes),
            mandatory: meta.mandatory,
          };
        } catch (error) {
          return fail(`invalid front matter in rules/${name}`, error);
        }
      },
      errors,
    ),
  );
}

function loadSkills(squadDir: string, errors?: ConfigValidationError[]): CatalogEntry[] {
  let lock: z.infer<typeof skillsLockSchema>;
  try {
    const text = readFileSync(join(squadDir, "provenance", "skills.lock.json"), "utf8");
    lock = skillsLockSchema.parse(JSON.parse(text));
  } catch (error) {
    return fail("invalid provenance/skills.lock.json", error);
  }
  return lock.skills.flatMap((skill) =>
    collect(
      join(squadDir, "provenance", "skills.lock.json"),
      () => {
        const actualFiles = skill.files.map((file) => ({
          path: file.path,
          sha256: sha256(readFileSync(join(squadDir, file.path))),
        }));
        for (const [index, actual] of actualFiles.entries()) {
          if (actual.sha256 !== skill.files[index]?.sha256) {
            throw new CatalogLoadError(
              `skill "${skill.id}" file ${actual.path} differs from the lock`,
            );
          }
        }
        if (aggregateSkillHash(actualFiles) !== skill.sha256) {
          throw new CatalogLoadError(`skill "${skill.id}" hash differs from the lock`);
        }
        return { id: skill.id, version: skill.version, sha256: skill.sha256 };
      },
      errors,
    ),
  );
}

/**
 * Reads a `.omi-squad` directory into a catalog. Each role and rule is hashed from its file
 * bytes; each skill is re-hashed from its files and must match the provenance lock, so a stale
 * or edited skill fails loudly instead of resolving with a wrong hash.
 */
export function loadResolutionCatalog(
  squadDir: string,
  errors?: ConfigValidationError[],
  roleFiles?: Map<CatalogRole, string>,
): ResolutionCatalog {
  return {
    roles: collect(
      join(squadDir, "roles"),
      () => loadRoles(squadDir, errors, roleFiles),
      errors,
    ).flat(),
    skills: collect(
      join(squadDir, "provenance/skills.lock.json"),
      () => loadSkills(squadDir, errors),
      errors,
    ).flat(),
    rules: collect(join(squadDir, "rules"), () => loadRules(squadDir, errors), errors).flat(),
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
