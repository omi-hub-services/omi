import type { Command } from "commander";
import type { DockerLifecycle } from "../../../application/ports/docker-runtime.js";
import type { CliContext, GlobalOptions } from "./command-context.js";
import { formatOf } from "./command-context.js";
import { presentFailure, presentSuccess } from "../presenters/result-presenter.js";

export function registerDockerCommands(
  program: Command,
  context: CliContext,
  lifecycle?: DockerLifecycle,
): void {
  const docker = program.command("docker").description("Project worker container lifecycle");
  for (const action of ["build", "up", "down"] as const) {
    const command = docker.command(action).option("--project <path>", "project directory");
    if (action === "down") command.option("--volumes", "also remove project and login volumes");
    command.action(async (options: { project?: string; volumes?: boolean }, cmd: Command) => {
      const format = formatOf(cmd.optsWithGlobals<GlobalOptions>());
      try {
        if (lifecycle === undefined) throw new Error("Docker lifecycle unavailable");
        await lifecycle(action, {
          ...(options.project === undefined ? {} : { projectDir: options.project }),
          ...(options.volumes === undefined ? {} : { volumes: options.volumes }),
        });
        context.emit(presentSuccess({ action }, `Docker ${action} completed`, format));
      } catch {
        context.emit(
          presentFailure(
            {
              code: "COMMAND_REFUSED",
              message: `Docker ${action} failed; check Docker and project settings`,
            },
            format,
          ),
        );
      }
    });
  }
}
