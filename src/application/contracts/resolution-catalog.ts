import type { Role } from "./role.js";

/** A skill or rule available to resolution, pinned by version and content hash. */
export interface CatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
}

export interface CatalogRule extends CatalogEntry {
  readonly mandatory: boolean;
}

export interface CatalogRole {
  readonly definition: Role;
  readonly sha256: string;
}

/** Everything the resolver may choose from; built and hash-verified by infrastructure/config. */
export interface ResolutionCatalog {
  readonly roles: readonly CatalogRole[];
  readonly skills: readonly CatalogEntry[];
  readonly rules: readonly CatalogRule[];
}
