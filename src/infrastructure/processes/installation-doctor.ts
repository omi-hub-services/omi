import { access, readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { join } from "node:path";
import type { ProjectConfig } from "../../application/contracts/project-config.js";
import { sessionLaunchSchema, wslPathSchema } from "../../application/contracts/session-launch.js";
import type {
  InstallationDoctor,
  InstallationDoctorCheck,
} from "../../application/ports/installation-doctor.js";
import { createOnboardingProjectConfigStore } from "../config/project-config-store.js";
import { runCommand } from "./run-command.js";
import { classifyWorkerCli } from "./worker-cli-compatibility.js";

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
  /** The project's `project.yaml`, or undefined when missing or invalid. */
  projectConfig(projectDir: string): Promise<ProjectConfig | undefined>;
}

const loginSchema = z.object({ login: z.string() });
const userTypeSchema = z.object({ type: z.string() });
const repositorySchema = z.object({ permissions: z.object({ push: z.boolean() }) });
const projectAccessSchema = z.object({
  data: z.object({
    repositoryOwner: z.object({ projectV2: z.object({ viewerCanUpdate: z.boolean() }) }),
  }),
});
const PROJECT_QUERY =
  "query($owner:String!,$number:Int!){repositoryOwner(login:$owner){... on Organization{projectV2(number:$number){viewerCanUpdate}} ... on User{projectV2(number:$number){viewerCanUpdate}}}}";

function parseWith<T>(schema: z.ZodType<T>, text: string | undefined): T | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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
  projectConfig: async (projectDir) => {
    try {
      return await createOnboardingProjectConfigStore(projectDir).read();
    } catch {
      return undefined;
    }
  },
};

/** Probes only. Windows output is normalized for wsl.exe's UTF-16LE ASCII table. */
export function createInstallationDoctor(probe: WslProbe = systemProbe): InstallationDoctor {
  return async (raw) => {
    const input = doctorInputSchema.parse(raw);
    const checks: InstallationDoctorCheck[] = [];
    const check = (
      name: string,
      ok: boolean,
      detail: string,
      fix: string,
      classification?: InstallationDoctorCheck["classification"],
    ) =>
      checks.push({
        name,
        ok,
        status: ok ? "pass" : "fail",
        detail,
        fix,
        ...(classification === undefined ? {} : { classification }),
      });
    let kernel = "";
    try {
      kernel = await probe.kernel();
    } catch {
      /* reported below */
    }
    check(
      "wsl2-kernel",
      /microsoft.*wsl2/i.test(kernel),
      "Requires a WSL2 Linux kernel",
      "Run the Coordinator inside a WSL2 distribution",
    );
    check(
      "distribution",
      probe.distro() === input.distribution,
      "Current distro must match the project binding",
      `Run inside the ${input.distribution} distribution or pass the bound --distribution`,
    );
    check(
      "interop",
      await probe.interop(),
      "Requires WSL interop and an accessible WSL_INTEROP socket",
      "Enable WSL interop (wsl.conf [interop] enabled=true) and restart the distro",
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
      `Run wsl.exe --set-version ${input.distribution} 2`,
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
      "Keep the project on the Linux filesystem (not /mnt/<drive>), not behind a symlink",
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
      "Reinstall the project shim with omi install --apply",
    );

    // GitHub identity and permissions. Only the login, user type and permission booleans are read
    // from gh; auth output is never stored, so no token can reach the report.
    const gh = (args: readonly string[]) => probe.command("gh", args, input.projectDir);
    const authenticated = (await gh(["auth", "status"])) !== undefined;
    check(
      "github-auth",
      authenticated,
      "gh must be logged in as the agent account",
      "Run gh auth login (agent account) with repo and project scopes",
    );
    const read = async <T>(schema: z.ZodType<T>, args: readonly string[]) =>
      authenticated ? parseWith(schema, await gh(args)) : undefined;
    const config = await probe.projectConfig(input.projectDir);
    const configFix = "Fix .omi-squad/config/project.yaml (repository, project, policies)";
    const login = (await read(loginSchema, ["api", "user"]))?.login.toLowerCase();
    const actors = config?.policies.github_approval_actors ?? [];
    check(
      "github-agent-identity",
      config !== undefined && login !== undefined && !actors.some((a) => a.toLowerCase() === login),
      "The gh account must be an agent account, distinct from every PO in github_approval_actors",
      config === undefined
        ? configFix
        : "Log gh in as the agent account, never a PO listed in policies.github_approval_actors",
    );
    const repo =
      config === undefined
        ? undefined
        : await read(repositorySchema, [
            "api",
            `repos/${config.repository.owner}/${config.repository.name}`,
          ]);
    check(
      "github-repository-access",
      repo?.permissions.push === true,
      "The gh account needs write access to the repository",
      config === undefined
        ? configFix
        : "Grant the agent account write access to the repository and re-run gh auth login",
    );
    const project =
      config === undefined
        ? undefined
        : await read(projectAccessSchema, [
            "api",
            "graphql",
            "-f",
            `query=${PROJECT_QUERY}`,
            "-f",
            `owner=${config.project.owner}`,
            "-F",
            `number=${String(config.project.number)}`,
          ]);
    check(
      "github-project-access",
      project?.data.repositoryOwner.projectV2.viewerCanUpdate === true,
      "The gh account must be able to update the GitHub Project",
      config === undefined
        ? configFix
        : "Add the agent account to the Project with write access and grant the project scope",
    );
    let hasUser = false;
    for (const actor of actors) {
      if ((await read(userTypeSchema, ["api", `users/${actor}`]))?.type === "User") {
        hasUser = true;
        break;
      }
    }
    check(
      "github-approval-allowlist",
      hasUser,
      "policies.github_approval_actors must contain at least one GitHub User",
      "Add a PO's GitHub user login to policies.github_approval_actors",
    );

    // Worker CLIs: ranges come from the adapters (compatibility.md), classified once here.
    const classified: ("supported" | "untested" | "unsupported" | "not-installed")[] = [];
    for (const cli of ["claude", "codex"] as const) {
      const output = await probe.command(cli, ["--version"], input.projectDir);
      if (output === undefined) {
        classified.push("not-installed");
        check(
          `worker-cli-${cli}`,
          true,
          `${cli} is not installed; optional if another worker CLI is supported`,
          `Install ${cli} within the supported range to use it as a worker`,
          "not-installed",
        );
        continue;
      }
      const { classification, version, range } = classifyWorkerCli(cli, output);
      classified.push(classification);
      check(
        `worker-cli-${cli}`,
        classification === "supported",
        `${cli} ${version ?? "version not recognised"}: ${classification}; supported ${range}`,
        classification === "supported"
          ? "No action needed"
          : `Install ${cli} ${range} (see docs/operations/compatibility.md)`,
        classification,
      );
    }
    check(
      "worker-cli-available",
      classified.includes("supported"),
      "At least one worker CLI (claude or codex) must be in its supported range",
      "Install a supported claude or codex CLI (see docs/operations/compatibility.md)",
    );
    return { version: 1, distribution: input.distribution, checks };
  };
}
