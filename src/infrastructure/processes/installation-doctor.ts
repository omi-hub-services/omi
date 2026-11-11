import { access, readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { join } from "node:path";
import { sessionLaunchSchema, wslPathSchema } from "../../application/contracts/session-launch.js";
import type { InstallationDoctor } from "../../application/ports/installation-doctor.js";
import { runCommand } from "./run-command.js";

export const doctorInputSchema = z.strictObject({
  projectDir: wslPathSchema,
  distribution: sessionLaunchSchema.shape.distribution.unwrap(),
});
export interface WslProbe {
  kernel(): Promise<string>;
  distro(): string | undefined;
  interop(): Promise<boolean>;
  command(executable: string, args: readonly string[], cwd: string): Promise<string | undefined>;
  canonical(path: string): Promise<string>;
}
const systemProbe: WslProbe = {
  kernel: () => readFile("/proc/sys/kernel/osrelease", "utf8"),
  distro: () => process.env["WSL_DISTRO_NAME"],
  interop: async () => {
    const socket = process.env["WSL_INTEROP"];
    if (socket === undefined) return false;
    try {
      await access(socket);
      return (await readFile("/proc/sys/fs/binfmt_misc/WSLInterop", "utf8")).startsWith("enabled");
    } catch {
      return false;
    }
  },
  command: async (executable, args, cwd) => {
    const result = await runCommand({
      executable,
      args,
      cwd,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (pair): pair is [string, string] => pair[1] !== undefined,
        ),
      ),
      timeoutMs: 10_000,
    });
    return result.kind === "finished" && result.exit.exitCode === 0 ? result.stdout : undefined;
  },
  canonical: realpath,
};

/** Probes only. Windows output is normalized for wsl.exe's UTF-16LE ASCII table. */
export function createInstallationDoctor(probe: WslProbe = systemProbe): InstallationDoctor {
  return async (raw) => {
    const input = doctorInputSchema.parse(raw);
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
    let kernel = "";
    try {
      kernel = await probe.kernel();
    } catch {
      /* reported below */
    }
    check("wsl2-kernel", /microsoft.*wsl2/i.test(kernel), "Requires a WSL2 Linux kernel");
    check(
      "distribution",
      probe.distro() === input.distribution,
      "Current distro must match the project binding",
    );
    check(
      "interop",
      await probe.interop(),
      "Requires WSL interop and an accessible WSL_INTEROP socket",
    );
    const list = (
      await probe.command("wsl.exe", ["--list", "--verbose"], input.projectDir)
    )?.replaceAll("\0", "");
    const rows = list?.split(/\r?\n/).map((line) =>
      line
        .trim()
        .replace(/^\*\s*/, "")
        .split(/\s+/),
    );
    check(
      "distribution-version",
      rows?.some((row) => row[0] === input.distribution && row.at(-1) === "2") ?? false,
      "Bound distro must be registered as WSL version 2",
    );
    const windowsPath = await probe.command("wslpath", ["-w", input.projectDir], input.projectDir);
    const expected = `\\\\wsl.localhost\\${input.distribution}\\`;
    const older = `\\\\wsl$\\${input.distribution}\\`;
    const unc = windowsPath?.trim();
    const back =
      unc === undefined ? undefined : await probe.command("wslpath", ["-u", unc], input.projectDir);
    let canonical = "";
    try {
      canonical = await probe.canonical(input.projectDir);
    } catch {
      /* reported below */
    }
    check(
      "path-mapping",
      canonical === input.projectDir &&
        !/^\/mnt\/[a-z](?:\/|$)/i.test(canonical) &&
        (unc?.startsWith(expected) === true || unc?.startsWith(older) === true) &&
        back?.trim() === canonical,
      "Requires a Linux checkout with a reversible Windows UNC mapping",
    );
    const shim = join(input.projectDir, ".omi-squad", "bin", "omi");
    const reached = await probe.command(
      "wsl.exe",
      ["--distribution", input.distribution, "--cd", input.projectDir, "--exec", shim, "--version"],
      input.projectDir,
    );
    check(
      "windows-launch",
      reached !== undefined && /^\d+\.\d+\.\d+/.test(reached.trim()),
      "Windows must reach this project's local shim through typed argv",
    );
    return { distribution: input.distribution, checks };
  };
}
