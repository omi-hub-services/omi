import type { Command } from "commander";
import { commandSchema } from "../../../application/contracts/command.js";
import { CONTRACT_SCHEMA_VERSION } from "../../../application/contracts/schema-version.js";
import { EXIT_CODES } from "../presenters/exit-codes.js";
import { presentFailure } from "../presenters/result-presenter.js";
import { formatOf } from "./command-context.js";
import type { CliContext, GlobalOptions } from "./command-context.js";
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

  program
    .command("login <profile-id>")
    .description("Show the native login step for a profile, then probe it (spawns nothing)")
    .action(async (id: string, _options: unknown, command: Command) => {
      await loginProfile(context, command, id);
    });
}

type ProfileStatus = "ready" | "login-required" | "unavailable";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const shellWord = (text: string): string =>
  /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;

/** Native step per ADR-0031. Only the profile directory reference is used, never a credential. */
function nativeLogin(tool: string, home: string) {
  const [variable, command, then] =
    tool === "codex"
      ? (["CODEX_HOME", "codex", "login"] as const)
      : (["CLAUDE_CONFIG_DIR", "claude", undefined] as const);
  const base = `${variable}=${shellWord(home)} ${command}`;
  return {
    env: { [variable]: home },
    command,
    steps: then === undefined ? `${base}, then /login` : `${base} ${then}`,
  };
}

/**
 * CLI-only wrapper over `profile.list` and `profile.probe` (OMI-109): prints the native login
 * step, reports the probed status, and exits 0 only for a ready profile. omi runs no login.
 */
async function loginProfile(context: CliContext, command: Command, id: string): Promise<void> {
  const globals = command.optsWithGlobals<GlobalOptions>();
  const format = formatOf(globals);
  const send = (candidate: Record<string, unknown>, timeoutMs: number) =>
    context.sendCommand({
      socketPath: globals.socket ?? context.defaultSocketPath,
      timeoutMs: Math.max(context.timeoutMs, timeoutMs),
      command: commandSchema.parse({ schemaVersion: CONTRACT_SCHEMA_VERSION, ...candidate }),
    });
  const listed = await send({ command: "profile.list" }, context.timeoutMs);
  if (!listed.ok) {
    context.emit(presentFailure(listed.error, format));
    return;
  }
  const profiles = record(listed.result)["profiles"];
  const found = (Array.isArray(profiles) ? profiles : [])
    .map((entry) => record(record(entry)["metadata"]))
    .find((metadata) => metadata["profileId"] === id);
  if (found === undefined || typeof found["credentialRef"] !== "string") {
    context.emit(presentFailure({ code: "COMMAND_REFUSED", message: "PROFILE_NOT_FOUND" }, format));
    return;
  }
  const tool = String(found["tool"]);
  const login = nativeLogin(tool, found["credentialRef"]);
  const probed = await send({ command: "profile.probe", profileId: id }, 65000);
  if (!probed.ok) {
    context.emit(presentFailure(probed.error, format));
    return;
  }
  const probe = record(probed.result);
  const reported = probe["outcome"] === "probed" ? probe["status"] : undefined;
  const status: ProfileStatus =
    reported === "ready" || reported === "login-required" ? reported : "unavailable";
  const result = { profileId: id, tool, status, login };
  const exitCode = status === "ready" ? EXIT_CODES.OK : EXIT_CODES.REQUEST_REJECTED;
  if (format === "json") {
    const doc = { schemaVersion: CONTRACT_SCHEMA_VERSION, ok: exitCode === 0, exitCode, result };
    context.emit({ stdout: `${JSON.stringify(doc)}\n`, stderr: "", exitCode });
    return;
  }
  const text = [
    `profile ${id} (${tool}): ${status}`,
    `native login: ${login.steps}`,
    "omi runs no login and reads no credential; log in with the native tool, then re-run this command.",
  ].join("\n");
  context.emit({ stdout: `${text}\n`, stderr: "", exitCode });
}
