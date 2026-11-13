import type { Command } from "commander";
import {
  importTaskSelectionSchema,
  storedTaskImportSchema,
} from "../../../application/contracts/task-import.js";
import { GATED_STATUSES, planKeyPrefixSchema } from "../../../application/contracts/task-intake.js";
import type { createIssueFromSpec } from "../../../application/use-cases/tasks/create-issue-from-spec.js";
import type { promoteTask } from "../../../application/use-cases/tasks/promote-task.js";
import type { setTaskStatus } from "../../../application/use-cases/tasks/set-task-status.js";
import { EXIT_CODES } from "../presenters/exit-codes.js";
import {
  presentFailure,
  presentSuccess,
  presentUsageError,
} from "../presenters/result-presenter.js";
import type { OutputFormat } from "../presenters/result-presenter.js";
import {
  presentCreateIssue,
  presentPromotion,
  presentStatusChange,
} from "../presenters/task-presenter.js";
import { formatOf } from "./command-context.js";
import type { CliContext, GlobalOptions } from "./command-context.js";

/** Bootstrap binds these to the project's GitHub; the CLI only parses, calls and presents. */
export interface TaskCommands {
  newIssue(input: {
    projectDir: string;
    file: string;
    prefix: string;
    apply: boolean;
  }): ReturnType<typeof createIssueFromSpec>;
  promote(input: {
    projectDir: string;
    issueNumber?: number;
    dryRun: boolean;
  }): ReturnType<typeof promoteTask>;
  setStatus(input: {
    projectDir: string;
    issueNumber: number;
    status: string;
  }): ReturnType<typeof setTaskStatus>;
}

const issueNumberOf = (text: string): number | undefined =>
  /^[1-9]\d{0,9}$/.test(text) ? Number(text) : undefined;

export function registerTaskCommands(
  program: Command,
  context: CliContext,
  actions?: TaskCommands,
): void {
  program
    .command("import-task <issues...>")
    .description("Import GitHub Issues into the running runtime's business baseline")
    .action(async (issues: string[], _options: unknown, command: Command) => {
      const options = command.optsWithGlobals<GlobalOptions>();
      const format = formatOf(options);
      const parsed = importTaskSelectionSchema.safeParse({
        issueNumbers: issues.map(issueNumberOf),
      });
      if (!parsed.success) {
        context.emit(presentUsageError("give 1–1000 whole Issue numbers", format));
        return;
      }
      const outcome = await context.sendCommand({
        socketPath: options.socket ?? context.defaultSocketPath,
        timeoutMs: context.timeoutMs,
        command: { schemaVersion: 1, command: "task.import", ...parsed.data },
      });
      if (!outcome.ok) {
        context.emit(presentFailure(outcome.error, format));
        return;
      }
      const result = storedTaskImportSchema.safeParse(outcome.result);
      context.emit(
        result.success
          ? presentSuccess(
              result.data,
              result.data.snapshots
                .map((s) => `${s.taskId} content_hash=${s.contentHash} ${s.outcome}`)
                .join("\n"),
              format,
            )
          : presentFailure(
              { code: "PROTOCOL_ERROR", message: "invalid task import response" },
              format,
            ),
      );
    });

  /** Runs one action and presents it; a failure shows the adapter's fixed code text only. */
  async function run<T>(
    format: OutputFormat,
    action: (commands: TaskCommands) => Promise<T>,
    present: (result: T, format: OutputFormat) => ReturnType<typeof presentFailure>,
  ): Promise<void> {
    try {
      if (actions === undefined) throw new Error("TASKS_NOT_WIRED");
      context.emit(present(await action(actions), format));
    } catch (error) {
      context.emit(
        presentFailure(
          {
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : "TASK_COMMAND_FAILED",
          },
          format,
          EXIT_CODES.FAILURE,
        ),
      );
    }
  }

  program
    .command("new-issue")
    .description("Preview a new task Issue from a Markdown spec; --apply creates it on GitHub")
    .requiredOption("--project <path>", "absolute Linux project path")
    .requiredOption("--file <path>", "Markdown spec with YAML frontmatter")
    .option("--prefix <prefix>", "Plan Key prefix of the project", "OMI")
    .option("--apply", "create the Issue (without it nothing is written)")
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<
        GlobalOptions & { project: string; file: string; prefix: string; apply?: boolean }
      >();
      const format = formatOf(options);
      if (!planKeyPrefixSchema.safeParse(options.prefix).success) {
        context.emit(presentUsageError("--prefix must be capital letters and digits", format));
        return;
      }
      await run(
        format,
        (commands) =>
          commands.newIssue({
            projectDir: options.project,
            file: options.file,
            prefix: options.prefix,
            apply: options.apply ?? false,
          }),
        presentCreateIssue,
      );
    });

  program
    .command("promote")
    .description("Move a Backlog task to Ready when its blockers are closed and the gate passes")
    .argument("[issue]", "Issue number; without it the first eligible Backlog task is used")
    .requiredOption("--project <path>", "absolute Linux project path")
    .option("--dry-run", "show what would be promoted and write nothing")
    .action(async (issue: string | undefined, _options: unknown, command: Command) => {
      const options = command.optsWithGlobals<
        GlobalOptions & { project: string; dryRun?: boolean }
      >();
      const format = formatOf(options);
      const issueNumber = issue === undefined ? undefined : issueNumberOf(issue);
      if (issue !== undefined && issueNumber === undefined) {
        context.emit(presentUsageError("issue must be a whole Issue number", format));
        return;
      }
      await run(
        format,
        (commands) =>
          commands.promote({
            projectDir: options.project,
            ...(issueNumber === undefined ? {} : { issueNumber }),
            dryRun: options.dryRun ?? false,
          }),
        presentPromotion,
      );
    });

  program
    .command("set-status")
    .description("Set a task's Project Status to Ready or In Progress; the readiness gate applies")
    .argument("<issue>", "Issue number")
    .argument("<status>", GATED_STATUSES.join(" | "))
    .requiredOption("--project <path>", "absolute Linux project path")
    .action(async (issue: string, status: string, _options: unknown, command: Command) => {
      const options = command.optsWithGlobals<GlobalOptions & { project: string }>();
      const format = formatOf(options);
      const issueNumber = issueNumberOf(issue);
      if (issueNumber === undefined || !(GATED_STATUSES as readonly string[]).includes(status)) {
        context.emit(
          presentUsageError(
            `give a whole Issue number and a status of: ${GATED_STATUSES.join(", ")}`,
            format,
          ),
        );
        return;
      }
      await run(
        format,
        (commands) => commands.setStatus({ projectDir: options.project, issueNumber, status }),
        presentStatusChange,
      );
    });
}
