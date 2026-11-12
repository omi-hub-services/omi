import {
  evaluateQuota,
  type QuotaReading,
  type QuotaThresholds,
  type QuotaVerdict,
} from "../../domain/profiles/quota-policy.js";
import type { projectConfigSchema } from "../contracts/project-config.js";
import type { ProfileRegistry } from "../ports/profile-registry.js";
import type { QuotaReader } from "../ports/quota-reader.js";
import type { z } from "zod";

type QuotaPolicy = NonNullable<z.infer<typeof projectConfigSchema>["quota"]>;

/**
 * Reads every registered profile's quota and judges it against the project's thresholds. Shared by
 * dispatch (which selects on it) and `status` (which only shows it). A reader that throws counts
 * as no reading: a missing number never stops anything. `probe: false` never spends a
 * subscription call, whatever the policy says.
 */
export function createQuotaVerdictReader(deps: {
  readonly policy: QuotaPolicy;
  readonly reader: QuotaReader;
  readonly profiles: Pick<ProfileRegistry, "list">;
  readonly now: () => number;
  readonly probe: boolean;
}): (requiredExecutor?: string) => Promise<ReadonlyMap<string, QuotaVerdict>> {
  const { policy, reader } = deps;
  const thresholds: QuotaThresholds = {
    minFiveHourLeftPercent: policy.min_five_hour_left_percent,
    minSevenDayLeftPercent: policy.min_seven_day_left_percent,
    coordinatorSharedPenalty: policy.coordinator_shared_penalty,
    coordinatorSharedPolicy: policy.coordinator_shared_policy,
    staleAfterMs: policy.stale_after_minutes * 60_000,
  };
  return async (requiredExecutor) => {
    const now = deps.now();
    const entries = await Promise.all(
      deps.profiles
        .list()
        .filter(
          ({ metadata }) => requiredExecutor === undefined || metadata.tool === requiredExecutor,
        )
        .map(async ({ metadata }) => {
          const ref = {
            profileId: metadata.profileId,
            tool: metadata.tool,
            credentialRef: metadata.credentialRef,
          };
          const read = (probe: boolean) =>
            reader.read(ref, { now, probe }).then(
              (result) => result.reading,
              () => null,
            );
          const evaluate = (reading: QuotaReading | null) =>
            evaluateQuota(
              {
                profileId: metadata.profileId,
                sharesCoordinatorAccount: policy.coordinator_shared_profiles.includes(
                  metadata.profileId,
                ),
                reading,
              },
              thresholds,
              now,
            );
          let reading = await read(false);
          let verdict = evaluate(reading);
          if (deps.probe && policy.probe_when_stale && verdict.freshness !== "fresh") {
            reading = (await read(true)) ?? reading;
            verdict = evaluate(reading);
          }
          return [metadata.profileId, verdict] as const;
        }),
    );
    return new Map(entries);
  };
}
