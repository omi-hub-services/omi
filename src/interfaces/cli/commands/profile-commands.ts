import type { Command } from "commander";
import type { CliContext } from "./command-context.js";
import { runCommand } from "./run-commands.js";

export function registerProfileCommands(program: Command, context: CliContext): void {
  const profiles = program
    .command("profiles")
    .description("Native subscription profile metadata (login with the native tool first)");
  profiles
    .command("register <id>")
    .requiredOption("--tool <tool>", "claude-code or codex")
    .requiredOption("--profile-home <path>", "native CLAUDE_CONFIG_DIR or CODEX_HOME directory")
    .requiredOption("--account-group <id>", "same account uses the same quota group")
    .option(
      "--model <name>",
      "verified native model name (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .action(
      async (
        id: string,
        options: { tool: string; profileHome: string; accountGroup: string; model: string[] },
        command: Command,
      ) => {
        await runCommand(context, command, {
          command: "profile.register",
          profileId: id,
          tool: options.tool,
          credentialRef: options.profileHome,
          accountGroupId: options.accountGroup,
          modelAllowlist: options.model,
        });
      },
    );
  profiles.command("list").action(async (_options: unknown, command: Command) => {
    await runCommand(context, command, { command: "profile.list" });
  });
  profiles.command("probe <id>").action(async (id: string, _options: unknown, command: Command) => {
    await runCommand(context, command, { command: "profile.probe", profileId: id }, 65000);
  });
}
