import { probeResultSchema } from "../../contracts/agent-execution.js";
import { identifierSchema } from "../../contracts/identifiers.js";
import type { AgentExecutor } from "../../ports/agent-executor.js";
import type { ProfileRegistry } from "../../ports/profile-registry.js";

/** Clock is sampled after the awaited probe; network/process waits never hold a DB transaction. */
export async function probeProfile(
  registry: ProfileRegistry,
  executor: Pick<AgentExecutor, "executor" | "probe">,
  profileId: string,
  now: () => number,
  canSave: () => boolean = () => true,
) {
  identifierSchema.parse(profileId);
  const profile = registry.list().find((entry) => entry.metadata.profileId === profileId);
  if (profile === undefined) throw new Error("Unknown profile");
  const metadata = profile.metadata;
  if (executor.executor !== metadata.tool) throw new Error("Profile executor mismatch");
  if (metadata.state === "disabled") return { outcome: "disabled" } as const;
  // Auth/version probes do not test model quota. Never erase an active quota cooldown.
  if (metadata.state === "cooldown" && (metadata.cooldownUntil ?? 0) > now()) {
    return { outcome: "cooldown" } as const;
  }
  const result = probeResultSchema.parse(
    await executor.probe({ profileHome: metadata.credentialRef }),
  );
  if (result.executor !== metadata.tool) throw new Error("Probe executor mismatch");
  if (!canSave()) return { outcome: "stale" } as const;
  const at = now();
  const refreshed = { ...metadata };
  delete refreshed.cooldownUntil;
  const saved = registry.save(
    {
      ...refreshed,
      state:
        result.status === "ready"
          ? profile.activeWorkers > 0
            ? "busy"
            : "ready"
          : result.status === "login-required"
            ? "login-required"
            : "unavailable",
      lastProbeAt: at,
    },
    at,
    profile.revision,
  );
  return { outcome: saved ? "probed" : "stale", status: result.status } as const;
}
