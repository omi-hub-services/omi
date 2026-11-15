import { parseProfileMetadata, registerProfileSchema } from "../../contracts/profile-metadata.js";
import type { ProfileRegistry } from "../../ports/profile-registry.js";

/** Registration cannot assert readiness or replace an existing profile's state. */
export function registerProfile(registry: ProfileRegistry, input: unknown, now: () => number) {
  try {
    const metadata = parseProfileMetadata({
      ...registerProfileSchema.parse(input),
      state: "unknown",
    });
    if (registry.list().some((entry) => entry.metadata.profileId === metadata.profileId))
      return { ok: false as const, reason: "PROFILE_EXISTS" };
    registry.save(metadata, now());
    return { ok: true as const, profile: metadata };
  } catch {
    return { ok: false as const, reason: "PROFILE_REGISTRATION_REFUSED" };
  }
}
