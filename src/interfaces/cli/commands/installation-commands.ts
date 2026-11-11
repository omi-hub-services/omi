import type { Command } from "commander";
import type { installProjectTool } from "../../../application/use-cases/project/install-project-tool.js";
import type { inspectInstallation } from "../../../application/use-cases/project/inspect-installation.js";
import { presentFailure, presentSuccess } from "../presenters/result-presenter.js";
import { EXIT_CODES } from "../presenters/exit-codes.js";
import { formatOf, type CliContext, type GlobalOptions } from "./command-context.js";

export interface InstallationCommands {
  install(input: unknown): ReturnType<typeof installProjectTool>;
  doctor(input: unknown): ReturnType<typeof inspectInstallation>;
}
export function registerInstallationCommands(
  program: Command,
  context: CliContext,
  actions?: InstallationCommands,
): void {
  for (const verb of ["install", "update"]) {
    program
      .command(verb)
      .description("Preview a project-local package installation; --apply writes after backup")
      .requiredOption("--project <path>", "absolute Linux project path")
      .requiredOption("--package <path>", "absolute path to an extracted omi-squad tarball")
      .requiredOption("--distribution <name>", "bound WSL2 distro")
      .option("--apply", "apply the previewed installation")
      .action(async (_options: unknown, command: Command) => {
        const options = command.optsWithGlobals<
          GlobalOptions & {
            project: string;
            package: string;
            distribution: string;
            apply?: boolean;
          }
        >();
        const format = formatOf(options);
        try {
          if (actions === undefined) throw new Error("INSTALLATION_NOT_WIRED");
          const result = await actions.install({
            projectDir: options.project,
            packageDir: options.package,
            distribution: options.distribution,
            apply: options.apply ?? false,
          });
          context.emit(
            result.status === "conflict"
              ? presentFailure(
                  {
                    code: "INTERNAL_ERROR",
                    message: `Template conflicts: ${result.conflicts.join(", ")}`,
                  },
                  format,
                  EXIT_CODES.FAILURE,
                )
              : presentSuccess(
                  result,
                  `${result.status}: ${result.version}; changes: ${result.changes.join(", ") || "none"}`,
                  format,
                ),
          );
        } catch (error) {
          context.emit(
            presentFailure(
              {
                code: "INTERNAL_ERROR",
                message: error instanceof Error ? error.message : "INSTALLATION_FAILED",
              },
              format,
              EXIT_CODES.FAILURE,
            ),
          );
        }
      });
  }
  program
    .command("doctor")
    .requiredOption("--project <path>", "absolute Linux project path")
    .requiredOption("--distribution <name>", "bound WSL2 distro")
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<
        GlobalOptions & { project: string; distribution: string }
      >();
      if (actions === undefined) throw new Error("DOCTOR_NOT_WIRED");
      const result = await actions.doctor({
        projectDir: options.project,
        distribution: options.distribution,
      });
      context.emit(
        result.supported
          ? presentSuccess(result, "WSL2 installation checks passed", formatOf(options))
          : presentFailure(
              {
                code: "INTERNAL_ERROR",
                message: result.checks
                  .filter((check) => !check.ok)
                  .map((check) => `${check.name}: ${check.detail}`)
                  .join("; "),
              },
              formatOf(options),
              EXIT_CODES.FAILURE,
            ),
      );
    });
}
