import type { ProfileMetadata, RegisteredProfile } from "../../domain/profiles/profile-metadata.js";

export interface ProfileRegistry {
  list(): readonly RegisteredProfile[];
  /** Append a validated snapshot; CAS prevents a late probe from overwriting a disable/cooldown. */
  save(metadata: ProfileMetadata, observedAt: number, expectedRevision?: number): boolean;
}
