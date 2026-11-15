export type DockerAction = "build" | "up" | "down";
export type DockerLifecycle = (
  action: DockerAction,
  options: { projectDir?: string; volumes?: boolean },
) => Promise<void>;
