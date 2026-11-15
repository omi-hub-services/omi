import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { Runner, Command } from "../../../tools/coordinator/process-runner.ts";
import { createProcessRunner, runChecked } from "../../../tools/coordinator/process-runner.ts";
import { dockerTarget } from "../../../tools/coordinator/coordinator-target.ts";
import { dispatchCommand } from "../../../tools/coordinator/flow-workers.ts";

export const liveDocker = process.env.OMI_LIVE_DOCKER === "1";
export const liveImage = process.env.OMI_LIVE_DOCKER_IMAGE ?? "omi-worker:0.1.1";
const execute = promisify(execFile);

/** Live tests require a dedicated context: lifecycle tests intentionally prune worker images. */
export function dockerContext(): string {
  const context = process.env.OMI_LIVE_DOCKER_CONTEXT;
  if (!context || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(context) || context === "default")
    throw new Error("Set OMI_LIVE_DOCKER_CONTEXT to an isolated Docker test context");
  return context;
}

export async function createDockerFixture() {
  const context = dockerContext();
  await mkdir(resolve(".tmp/docker-live"), { recursive: true });
  const root = await mkdtemp(resolve(".tmp/docker-live/project-"));
  const repo = basename(root);
  const container = `omi-${repo}`;
  const volume = `${container}-work`;
  const target = dockerTarget({ container, repoDir: `/work/${repo}` });
  const runBase = createProcessRunner();
  const run: Runner = (command: Command) =>
    runBase(
      command.file === "docker"
        ? { ...command, args: ["--context", context, ...command.args] }
        : command,
    );
  const docker = (args: readonly string[], extra: Omit<Command, "file" | "args"> = {}) =>
    runChecked(run, { file: "docker", args, timeoutMs: 600_000, ...extra });
  const stop = async () => {
    await docker(["rm", "--force", container]);
    await docker(["volume", "rm", volume]);
    await rm(root, { recursive: true, force: true });
  };
  await docker([
    "run",
    "--detach",
    "--init",
    "--name",
    container,
    "--restart",
    "unless-stopped",
    "--memory",
    "8g",
    "--mount",
    `type=volume,src=${volume},dst=/work`,
    liveImage,
  ]);
  try {
    await docker([
      "exec",
      container,
      "mkdir",
      "-p",
      "/work/framework",
      target.repoDir,
      "/work/fake-bin",
    ]);
    for (const path of ["dist", "package.json", "package-lock.json"])
      await docker(["cp", resolve(path), `${container}:/work/framework/${path}`]);
    await docker(["exec", "-w", "/work/framework", container, "npm", "ci"]);
    await docker(["exec", container, "mkdir", "-p", `${target.repoDir}/.omi/tool/node_modules`]);
    await docker([
      "exec",
      container,
      "ln",
      "-s",
      "/work/framework",
      `${target.repoDir}/.omi/tool/node_modules/omi-squad`,
    ]);
    await docker([
      "exec",
      container,
      "git",
      "-C",
      target.repoDir,
      "init",
      "--initial-branch=develop",
    ]);
    await docker([
      "exec",
      container,
      "git",
      "-C",
      target.repoDir,
      "config",
      "user.name",
      "live-test",
    ]);
    await docker([
      "exec",
      container,
      "git",
      "-C",
      target.repoDir,
      "config",
      "user.email",
      "live@example.com",
    ]);
    await docker([
      "exec",
      container,
      "git",
      "-C",
      target.repoDir,
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    await mkdir(join(root, ".omi"));
    const settings = {
      version: 1,
      github: {
        token: "fake-docker-live-secret",
        gitUser: { name: "live", email: "live@example.com" },
      },
      profiles: [
        { id: "test", tool: "claude", auth: { type: "token", token: "fake-docker-live-claude" } },
      ],
      docker: { container },
    };
    await writeFile(join(root, ".omi/omisetting.local.json"), JSON.stringify(settings));
    const fake = join(root, "claude");
    await writeFile(
      fake,
      "#!/usr/local/bin/node\nrequire('node:fs').writeFileSync(process.env.TMPDIR + '/scratch', 'fake'); const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); child.unref(); console.log(JSON.stringify({type:'result',is_error:false,result:'fake task step completed',num_turns:1}));\n",
      { mode: 0o755 },
    );
    await docker(["cp", fake, `${container}:/work/fake-bin/claude`]);
    await docker([
      "exec",
      "--user",
      "root",
      container,
      "ln",
      "-sf",
      "/work/fake-bin/claude",
      "/usr/local/bin/claude",
    ]);
    return { root, target, run, docker, stop, settings, context };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function dispatchFakeTask(
  fixture: Awaited<ReturnType<typeof createDockerFixture>>,
  task = "156",
  repoDir = fixture.target.repoDir,
) {
  return dispatchCommand(
    { run: fixture.run, target: { ...fixture.target, repoDir }, projectDir: fixture.root },
    {
      planKey: `OMI-${task}`,
      role: "developer",
      workflow: "feature",
      complexity: "low",
      kind: "claude",
      profile: "test",
      resume: null,
      prompt: "Fake live task step",
      dryRun: false,
    },
  );
}

export async function writeFixtureFile(
  container: string,
  context: string,
  file: string,
  destination: string,
  text: string,
) {
  await writeFile(file, text);
  await execute("docker", ["--context", context, "cp", file, `${container}:${destination}`]);
}
