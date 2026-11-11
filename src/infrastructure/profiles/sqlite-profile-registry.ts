import { z } from "zod";
import { parseProfileMetadata } from "../../application/contracts/profile-metadata.js";
import type { ProfileRegistry } from "../../application/ports/profile-registry.js";
import type { RegisteredProfile } from "../../domain/profiles/profile-metadata.js";
import type { StateDatabase } from "../persistence/sqlite/sqlite-connection.js";
import { runInTransaction } from "../persistence/sqlite/sqlite-transaction.js";

const observationSchema = z.strictObject({
  id: z.number().int().positive(),
  profile_id: z.string(),
  availability: z.string(),
  cooldown_until: z.string().nullable(),
  metadata_json: z.string(),
  active_workers: z.number().int().nonnegative(),
});

export function createSqliteProfileRegistry(db: StateDatabase): ProfileRegistry {
  const list = (): RegisteredProfile[] =>
    db
      .prepare(
        `
    SELECT o.id, o.profile_id, o.availability, o.cooldown_until, o.metadata_json,
      (SELECT count(*) FROM agent_attempts a
       WHERE a.profile_id=o.profile_id AND a.status IN ('pending','running')) AS active_workers
    FROM profile_observations o
    WHERE o.metadata_json IS NOT NULL AND o.id=(
      SELECT max(latest.id) FROM profile_observations latest
      WHERE latest.profile_id=o.profile_id AND latest.metadata_json IS NOT NULL)
    ORDER BY o.profile_id`,
      )
      .all()
      .map((input) => {
        const row = observationSchema.parse(input);
        const metadata = parseProfileMetadata(JSON.parse(row.metadata_json));
        if (
          metadata.profileId !== row.profile_id ||
          metadata.state !== row.availability ||
          (metadata.cooldownUntil === undefined
            ? null
            : new Date(metadata.cooldownUntil).toISOString()) !== row.cooldown_until
        ) {
          throw new Error("Profile snapshot disagrees with its indexed observation");
        }
        return { metadata, revision: row.id, activeWorkers: row.active_workers };
      });
  return {
    list,
    save(input, observedAt, expectedRevision) {
      const metadata = parseProfileMetadata(input);
      const at = new Date(z.number().int().nonnegative().parse(observedAt)).toISOString();
      return runInTransaction(db, () => {
        const profiles = list();
        const existing = profiles.find((entry) => entry.metadata.profileId === metadata.profileId);
        if (expectedRevision !== undefined && existing?.revision !== expectedRevision) return false;
        // Directory/tool/account identity must not change underneath existing attempt history.
        if (
          existing !== undefined &&
          (existing.metadata.tool !== metadata.tool ||
            existing.metadata.accountGroupId !== metadata.accountGroupId ||
            existing.metadata.credentialRef !== metadata.credentialRef)
        ) {
          throw new Error("Registered profile identity is immutable");
        }
        if (
          metadata.tool === "codex" &&
          profiles.some(
            (entry) =>
              entry.metadata.tool === "codex" && entry.metadata.profileId !== metadata.profileId,
          )
        ) {
          throw new Error("Only one Codex profile is supported");
        }
        db.prepare(
          `INSERT INTO profile_observations
          (profile_id, availability, cooldown_until, source, observed_at, metadata_json)
          VALUES (?, ?, ?, 'registry', ?, ?)`,
        ).run(
          metadata.profileId,
          metadata.state,
          metadata.cooldownUntil === undefined
            ? null
            : new Date(metadata.cooldownUntil).toISOString(),
          at,
          JSON.stringify(metadata),
        );
        return true;
      });
    },
  };
}
