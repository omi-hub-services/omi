import { z } from "zod";
import { contextPacketSchema } from "../contracts/context.js";
import { slugSchema } from "../contracts/identifiers.js";
import type { CatalogEntry, ResolutionCatalog } from "../contracts/resolution-catalog.js";

const manifestSchema = contextPacketSchema.shape.skillsManifest;
type Manifest = z.infer<typeof manifestSchema>;

const requestSchema = z.strictObject({
  role: slugSchema,
  /** Extra skills/rules a workflow step asks for on top of the role's own. */
  stepSkills: z.array(slugSchema).default([]),
  stepRules: z.array(slugSchema).default([]),
  /** Rules a project override wants removed. Mandatory rules cannot be removed. */
  excludedRules: z.array(slugSchema).default([]),
});
export type RoleResolutionRequest = z.input<typeof requestSchema>;

export interface ResolvedRoleContext {
  readonly role: { readonly id: string; readonly version: number; readonly sha256: string };
  /** Sorted by id; entries can be copied into a context packet manifest unchanged. */
  readonly skills: Manifest;
  readonly rules: Manifest;
}

export type RoleResolutionErrorCode =
  "UNKNOWN_REFERENCE" | "MANDATORY_RULE_DROPPED" | "AMBIGUOUS_CATALOG";

export class RoleResolutionError extends Error {
  override readonly name = "RoleResolutionError";

  readonly code: RoleResolutionErrorCode;

  constructor(code: RoleResolutionErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function indexById<T extends CatalogEntry>(kind: string, entries: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const entry of entries) {
    if (index.has(entry.id)) {
      throw new RoleResolutionError("AMBIGUOUS_CATALOG", `duplicate ${kind} id "${entry.id}"`);
    }
    index.set(entry.id, entry);
  }
  return index;
}

function lookup<T>(kind: string, index: Map<string, T>, id: string, source: string): T {
  const found = index.get(id);
  if (found === undefined) {
    throw new RoleResolutionError("UNKNOWN_REFERENCE", `unknown ${kind} "${id}" (${source})`);
  }
  return found;
}

function toManifest(entries: readonly CatalogEntry[]): Manifest {
  return manifestSchema.parse(
    [...entries]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ id, version, sha256 }) => ({ id, version, sha256 })),
  );
}

/**
 * Pure and deterministic: the same catalog and request always give the same result, whatever the
 * order of the inputs. Skills are the union of the role's and the step's; rules additionally
 * always include every mandatory rule in the catalog. Every referenced id must exist, and asking
 * to exclude a mandatory rule is an error rather than a silent no-op.
 */
export function resolveRoleContext(
  catalog: ResolutionCatalog,
  request: RoleResolutionRequest,
): ResolvedRoleContext {
  const { role: roleId, stepSkills, stepRules, excludedRules } = requestSchema.parse(request);
  const roles = indexById(
    "role",
    catalog.roles.map((role) => ({
      id: role.definition.id,
      version: String(role.definition.version),
      sha256: role.sha256,
    })),
  );
  const skills = indexById("skill", catalog.skills);
  const rules = indexById("rule", catalog.rules);
  const roleEntry = lookup("role", roles, roleId, "request");
  const definition = catalog.roles.find((role) => role.definition.id === roleId)?.definition;
  if (definition === undefined) {
    throw new RoleResolutionError("UNKNOWN_REFERENCE", `unknown role "${roleId}" (request)`);
  }

  for (const id of excludedRules) {
    if (lookup("rule", rules, id, "excluded").mandatory) {
      throw new RoleResolutionError(
        "MANDATORY_RULE_DROPPED",
        `mandatory rule "${id}" cannot be excluded`,
      );
    }
  }

  const skillIds = new Set([...definition.skills, ...stepSkills]);
  for (const id of skillIds) lookup("skill", skills, id, `role "${roleId}" or step`);

  const ruleIds = new Set([...definition.rules, ...stepRules]);
  for (const id of ruleIds) lookup("rule", rules, id, `role "${roleId}" or step`);
  for (const id of excludedRules) ruleIds.delete(id);
  for (const rule of catalog.rules) if (rule.mandatory) ruleIds.add(rule.id);

  return {
    role: {
      id: roleId,
      version: definition.version,
      sha256: roleEntry.sha256,
    },
    skills: toManifest([...skillIds].map((id) => lookup("skill", skills, id, "resolved"))),
    rules: toManifest([...ruleIds].map((id) => lookup("rule", rules, id, "resolved"))),
  };
}
