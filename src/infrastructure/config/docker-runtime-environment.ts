import { createRequire } from "node:module";
import type { OmiSetting } from "../../application/contracts/omisetting.js";

/** The standalone bridge owns this wire format; both launchers share its implementation. */
export function dockerRuntimeEnvironment(settings: OmiSetting): Readonly<Record<string, string>> {
  const bridge: unknown = createRequire(import.meta.url)("../../../templates/bridges/omi.cjs");
  if (
    typeof bridge !== "object" ||
    bridge === null ||
    !("dockerEnvironment" in bridge) ||
    typeof bridge.dockerEnvironment !== "function"
  )
    throw new Error("DOCKER_RELAY_UNAVAILABLE");
  return (
    bridge.dockerEnvironment as (settings: OmiSetting, profiles: boolean) => Record<string, string>
  )(settings, true);
}

/** Service children need GitHub access, never the runtime's profile token slots. */
export function dockerServiceEnvironment(
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parent).filter(
      (pair): pair is [string, string] =>
        pair[1] !== undefined &&
        pair[0] !== "OMI_DOCKER_SETTINGS" &&
        !pair[0].startsWith("OMI_DOCKER_PROFILE_TOKEN_"),
    ),
  );
}
