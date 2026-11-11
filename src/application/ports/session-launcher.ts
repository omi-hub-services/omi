import type { SessionLaunchInput } from "../contracts/session-launch.js";
/** Foreground lifetime: resolves only once the Coordinator and runtime have stopped. */
export type SessionLauncher = (
  input: SessionLaunchInput,
) => Promise<{ exitCode: number | null; runtimeStopped: boolean }>;
