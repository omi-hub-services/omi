// Host/WSL work target shared by runtime tooling and the source-independent pin bootstrap.
export interface WslTarget {
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
