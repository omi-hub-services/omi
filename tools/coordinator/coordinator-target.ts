// Host/WSL work target shared by runtime tooling and the source-independent pin bootstrap.
export interface WslTarget {
  readonly kind?: "wsl";
  /** true on Windows: steps go through wsl.exe; false inside Linux: run bash directly. */
  readonly viaWslExe: boolean;
  readonly distro: string;
  readonly repoDir: string;
}

export function wslTarget(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): WslTarget {
  return {
    viaWslExe: platform === "win32",
    distro: env.OMI_WSL_DISTRO ?? "Ubuntu-24.04",
    repoDir: env.OMI_WSL_REPO_DIR ?? "/home/ttin/github/omi",
  };
}

export interface DockerTarget {
  readonly kind: "docker";
  readonly container: string;
  readonly repoDir: string;
  readonly workerEntry?: string;
}
export type CoordinatorTarget = WslTarget | DockerTarget;

export function dockerTarget(project: { container: string; repoDir: string }): DockerTarget {
  return {
    kind: "docker",
    container: project.container,
    repoDir: project.repoDir,
    workerEntry: `${project.repoDir}/.omi/tool/node_modules/omi-squad/dist/infrastructure/processes/docker-worker.js`,
  };
}

/** Pin bootstrap can still import wslTarget without loading framework source. */
export async function coordinatorTarget(projectDir = process.cwd()): Promise<CoordinatorTarget> {
  await import("../register-ts-imports.ts");
  const { loadOmiSetting } = await import("../../src/infrastructure/config/load-omisetting.ts");
  const { dockerProject } = await import("../../src/infrastructure/processes/docker-runtime.ts");
  const settings = await loadOmiSetting(projectDir);
  return settings?.docker === undefined
    ? wslTarget()
    : dockerTarget(dockerProject(settings, projectDir, "0.1.1"));
}
