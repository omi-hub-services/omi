import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProfileLogin } from "../../application/ports/profile-login.js";
import { loadOmiSetting } from "../config/load-omisetting.js";
import { buildCodexEnvironment } from "../executors/codex/codex-environment.js";
import { dockerProject } from "../processes/docker-runtime.js";

export function codexProfileHome(id: string, home = homedir()): string {
  return join(home, ".codex-profiles", id);
}

/** The Windows shim reaches this through wsl.exe --exec, with no user shell or auth copy. */
export function createProfileLogin(
  options: { executable?: string; home?: string; parentEnv?: NodeJS.ProcessEnv; cwd?: string } = {},
): ProfileLogin {
  return async ({ projectDir = options.cwd ?? process.cwd(), profileId }) => {
    const settings = await loadOmiSetting(projectDir);
    const profile = settings?.profiles.find((entry) => entry.id === profileId);
    if (profile?.tool !== "codex") throw new Error("PROFILE_LOGIN_REQUIRES_CODEX_LOGIN_PROFILE");
    const target =
      settings?.docker === undefined ? undefined : dockerProject(settings, projectDir, "0.1.1");
    const store =
      target === undefined ? codexProfileHome(profile.id, options.home) : `/profiles/${profile.id}`;
    if (target === undefined) await mkdir(store, { recursive: true, mode: 0o700 });
    const env = buildCodexEnvironment(options.parentEnv ?? process.env, store);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        options.executable ?? (target === undefined ? "codex" : "docker"),
        [
          ...(target === undefined
            ? []
            : ["exec", "-i", "-e", "CODEX_HOME", target.container, "codex"]),
          "-c",
          'cli_auth_credentials_store="file"',
          "login",
          ...(target === undefined ? [] : ["--device-auth"]),
        ],
        { cwd: projectDir, env, shell: false, stdio: "inherit" },
      );
      child.once("error", () => {
        reject(new Error("PROFILE_LOGIN_FAILED"));
      });
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error("PROFILE_LOGIN_FAILED"));
      });
    });
  };
}
