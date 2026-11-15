import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OmiSetting } from "../../application/contracts/omisetting.js";
import type { DockerLifecycle } from "../../application/ports/docker-runtime.js";
import { loadOmiSetting } from "../config/load-omisetting.js";

export interface DockerTarget {
  readonly container: string;
  readonly repoDir: string;
}
export interface DockerCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}
export interface DockerResult {
  readonly code: number;
  readonly stdout: string;
}
export type DockerRunner = (command: DockerCommand) => Promise<DockerResult>;
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function dockerExecCommand(
  target: DockerTarget,
  payload: string,
  secretNames: readonly string[] = [],
): DockerCommand {
  if (
    !namePattern.test(target.container) ||
    !(target.repoDir === "/" || /^\/work\/[a-zA-Z0-9_./-]+$/.test(target.repoDir)) ||
    target.repoDir.split("/").includes("..")
  )
    throw new Error("Invalid Docker target");
  if (/["\\\r\n]/.test(payload))
    throw new Error("Docker payload must not contain double quotes, backslashes or newlines");
  if (secretNames.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name)))
    throw new Error("Invalid Docker environment name");
  return {
    file: "docker",
    args: [
      "exec",
      "-i",
      ...secretNames.flatMap((name) => ["-e", name]),
      "-w",
      target.repoDir,
      target.container,
      "bash",
      "-lc",
      payload,
    ],
  };
}

/** Fixed errors only: Docker/native output may include credentials. */
export const runDockerCommand: DockerRunner = (command) =>
  new Promise((resolveResult) => {
    const child = spawn(command.file, [...command.args], {
      env: { ...process.env, ...command.env },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length + chunk.length > 1_000_000) child.kill();
      else stdout += chunk;
    });
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    child.once("error", () => {
      resolveResult({ code: 127, stdout: "" });
    });
    child.once("close", (code) => {
      resolveResult({ code: code ?? 1, stdout });
    });
    child.stdin.end(command.input ?? "");
  });

export function dockerProject(settings: OmiSetting, projectDir: string, version: string) {
  const repo = basename(resolve(projectDir));
  if (!namePattern.test(repo)) throw new Error("Invalid project directory name");
  const container = settings.docker?.container ?? `omi-${repo}`;
  const image = settings.docker?.image ?? `omi-worker:${version}`;
  return {
    container,
    image,
    repo,
    repoDir: `/work/${repo}`,
    workVolume: `omi-${repo}-work`,
    memory: settings.docker?.memory ?? "8g",
    loginProfiles: settings.profiles
      .filter((profile) => profile.auth.type === "login")
      .map((p) => p.id),
  };
}

export function createDockerLifecycle(options: {
  version: string;
  run?: DockerRunner;
  templateDir?: string;
  settings?: typeof loadOmiSetting;
}): DockerLifecycle {
  const run = options.run ?? runDockerCommand;
  const checked = async (command: DockerCommand) => {
    const result = await run(command);
    if (result.code !== 0) throw new Error("DOCKER_COMMAND_FAILED");
    return result.stdout.trim();
  };
  const docker = (args: readonly string[]) => checked({ file: "docker", args });
  return async (action, input) => {
    const projectDir = resolve(input.projectDir ?? process.cwd());
    const settings = await (options.settings ?? loadOmiSetting)(projectDir);
    if (settings?.docker === undefined) throw new Error("DOCKER_SETTINGS_REQUIRED");
    const project = dockerProject(settings, projectDir, options.version);
    const profileVolumes = project.loginProfiles.map((id) => `omi-profile-${id}`);
    if (action === "build") {
      const builder = `${project.container}-builder`;
      const exists = await run({ file: "docker", args: ["buildx", "inspect", builder] });
      if (exists.code !== 0)
        await docker(["buildx", "create", "--name", builder, "--driver", "docker-container"]);
      await docker([
        "buildx",
        "build",
        "--builder",
        builder,
        "--load",
        "--tag",
        project.image,
        options.templateDir ??
          fileURLToPath(new URL("../../../templates/docker/", import.meta.url)),
      ]);
      const tags = await docker([
        "image",
        "ls",
        "omi-worker",
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ]);
      for (const tag of tags.split(/\r?\n/).filter(Boolean)) {
        if (!/^omi-worker:[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(tag)) continue;
        if (tag !== project.image) await docker(["image", "rm", tag]);
      }
      await docker([
        "image",
        "prune",
        "--force",
        "--filter",
        "label=org.opencontainers.image.title=omi-worker",
      ]);
      await docker(["buildx", "prune", "--builder", builder, "--force"]);
      return;
    }
    await docker(["version", "--format", "{{.Server.Version}}"]);
    if (action === "down") {
      const exists = await run({
        file: "docker",
        args: ["container", "inspect", project.container],
      });
      if (exists.code === 0) {
        await docker(["stop", project.container]);
        await docker(["rm", project.container]);
      }
      if (input.volumes)
        for (const volume of [project.workVolume, ...profileVolumes])
          await docker(["volume", "rm", volume]);
      return;
    }
    const remote = await checked({
      file: "git",
      args: ["-C", projectDir, "remote", "get-url", "origin"],
    });
    const match =
      /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote);
    if (!match?.[1]) throw new Error("GITHUB_REMOTE_REQUIRED");
    const exists = await run({
      file: "docker",
      args: ["container", "inspect", project.container, "--format", "{{.State.Running}}"],
    });
    if (exists.code !== 0) {
      await docker([
        "run",
        "--detach",
        "--init",
        "--name",
        project.container,
        "--restart",
        "unless-stopped",
        "--memory",
        project.memory,
        "-p",
        "127.0.0.1:4381:4381",
        "--mount",
        `type=volume,src=${project.workVolume},dst=/work`,
        ...project.loginProfiles.flatMap((id) => [
          "--mount",
          `type=volume,src=omi-profile-${id},dst=/profiles/${id}`,
        ]),
        project.image,
      ]);
    } else if (exists.stdout.trim() !== "true") await docker(["start", project.container]);
    for (const id of project.loginProfiles)
      await docker([
        "exec",
        "--user",
        "root",
        project.container,
        "chown",
        "-R",
        "omi:omi",
        `/profiles/${id}`,
      ]);
    for (const profile of settings.profiles.filter((entry) => entry.tool === "claude"))
      await docker([
        "exec",
        project.container,
        "mkdir",
        "-m",
        "700",
        "-p",
        `/work/.profiles/${profile.id}`,
      ]);
    await checked({
      file: "docker",
      args: [
        "exec",
        "-i",
        "-e",
        "GH_TOKEN",
        project.container,
        "node",
        "/usr/local/lib/omi-init.mjs",
      ],
      env: { GH_TOKEN: settings.github.token },
      input: JSON.stringify({
        repo: project.repo,
        url: `https://github.com/${match[1]}.git`,
        gitUser: settings.github.gitUser,
      }),
    });
  };
}
