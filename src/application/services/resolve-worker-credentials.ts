import type { OmiSetting, WorkerCredentials } from "../contracts/omisetting.js";
import type { RegisteredProfile } from "../../domain/profiles/profile-metadata.js";
import type { Executor } from "../contracts/model-capability.js";

/** An execution request carries a store reference, never a secret or a second profile token. */
export function resolveWorkerCredentials(
  settings: OmiSetting | undefined,
  profiles: readonly RegisteredProfile[],
  tool: Executor,
  home: string,
): WorkerCredentials {
  if (settings === undefined) return {};
  const registered = profiles.filter(
    ({ metadata }) => metadata.credentialRef === home && metadata.tool === tool,
  );
  const [selected] = registered;
  const profile = settings.profiles.find(
    (entry) =>
      entry.id === selected?.metadata.profileId &&
      entry.tool === (tool === "claude-code" ? "claude" : "codex"),
  );
  if (registered.length !== 1 || profile === undefined)
    throw new Error("SETTINGS_PROFILE_NOT_FOUND");
  return {
    githubToken: settings.github.token,
    ...(profile.auth.type === "token" ? { token: profile.auth.token } : {}),
  };
}
