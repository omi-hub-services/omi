import { evaluateProfileAvailability } from "../../../domain/profiles/availability-policy.js";
import type { ActiveRunReader } from "../../ports/active-run-reader.js";
import type { ProjectSession } from "../../ports/lease-store.js";
import type { ProfileRegistry } from "../../ports/profile-registry.js";
import { probeProfile } from "../profiles/probe-profile.js";
import { dispatchRunStep, type DispatchRunStepDependencies } from "./dispatch-run-step.js";

/** One pass over durable waiting steps; selection, reservations and completion stay in dispatch. */
export async function wakeWaitingRunSteps(
  deps: DispatchRunStepDependencies & {
    readonly runs: DispatchRunStepDependencies["runs"] & ActiveRunReader;
    readonly profiles: ProfileRegistry;
    readonly session: ProjectSession;
    readonly canDispatch: () => boolean;
  },
): Promise<number> {
  const accepting = () => deps.canDispatch() && deps.session.renew();
  const waiting = () =>
    deps.runs
      .listActive()
      .filter((run) => run.status === "running")
      .flatMap((run) =>
        deps.runs.listSteps(run.id).filter((step) => step.status === "waiting_resource"),
      );
  if (!accepting() || waiting().length === 0) return 0;
  for (const profile of deps.profiles.list()) {
    if (!accepting()) return 0;
    const availability = evaluateProfileAvailability(
      { ...profile.metadata, activeWorkers: profile.activeWorkers },
      deps.now(),
      profile.metadata.probeTtlMs,
    );
    if (
      availability.allowed ||
      availability.reasons.some(
        (reason) =>
          reason === "PROFILE_DISABLED" ||
          reason === "COOLDOWN_ACTIVE" ||
          reason === "AT_CONCURRENCY_LIMIT",
      )
    )
      continue;
    const executor = deps.executors?.[profile.metadata.tool] ?? deps.executor;
    try {
      await probeProfile(deps.profiles, executor, profile.metadata.profileId, deps.now, accepting);
    } catch {
      if (!accepting()) return 0;
      deps.session.record("profile.resource_probe_failed", {
        profileId: profile.metadata.profileId,
      });
    }
  }
  let dispatched = 0;
  for (const step of waiting()) {
    if (!accepting()) break;
    try {
      const result = await dispatchRunStep(
        { ...deps, canDispatch: accepting },
        { runId: step.runId, stepId: step.stepId },
      );
      if (result.ok) dispatched += 1;
    } catch {
      if (!accepting()) break;
      deps.session.record("step.resource_wakeup_refused", { stepRunId: step.id });
    }
  }
  return dispatched;
}
