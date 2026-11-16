import type { Command } from "commander";
import type {
  RulesetsMode,
  RulesetsResult,
} from "../../../application/use-cases/project/configure-github-rulesets.js";
import type { CliContext, GlobalOptions } from "./command-context.js";
import { formatOf } from "./command-context.js";
import { presentUsageError } from "../presenters/result-presenter.js";

export type GithubCommands = { rulesets(mode: RulesetsMode): Promise<RulesetsResult> };
export function registerGithubCommands(
  program: Command,
  context: CliContext,
  github?: GithubCommands,
): void {
  program
    .command("github")
    .description("GitHub project configuration")
    .command("rulesets")
    .description("Plan, apply or verify configured branch rulesets")
    .option("--dry-run", "read only and print planned calls")
    .option("--apply", "create or update differing rulesets")
    .option("--verify", "report missing or weaker rules")
    .action(
      async (
        options: { dryRun?: boolean; apply?: boolean; verify?: boolean },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals<GlobalOptions>();
        if (
          github === undefined ||
          [options.dryRun, options.apply, options.verify].filter(Boolean).length > 1
        ) {
          context.emit(
            presentUsageError(
              github === undefined
                ? "GitHub rulesets are unavailable"
                : "choose only one rulesets mode",
              formatOf(globals),
            ),
          );
          return;
        }
        const result = await github.rulesets(
          options.apply === true ? "apply" : options.verify === true ? "verify" : "dry-run",
        );
        const text = result.ok
          ? result.steps
              .map((step) => `${step.method} ${step.path} ${JSON.stringify(step.body)}\n`)
              .join("") || "Rulesets match\n"
          : result.failures
              .map(
                (failure) => `${result.code === undefined ? "" : `${result.code}: `}${failure}\n`,
              )
              .join("");
        context.emit({
          stdout: globals.json === true ? `${JSON.stringify(result)}\n` : result.ok ? text : "",
          stderr: globals.json === true || result.ok ? "" : text,
          exitCode: result.ok ? 0 : 1,
        });
      },
    );
}
