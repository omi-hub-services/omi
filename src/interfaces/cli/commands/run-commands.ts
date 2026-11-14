import type { Command } from "commander";
import { commandSchema } from "../../../application/contracts/command.js";
import { CONTRACT_SCHEMA_VERSION } from "../../../application/contracts/schema-version.js";
import {
  presentFailure,
  presentSuccess,
  presentUsageError,
} from "../presenters/result-presenter.js";
import { formatOf } from "./command-context.js";
import type { CliContext, GlobalOptions } from "./command-context.js";

/** Commands that touch worktrees or GitHub take longer than a status read. */
const SLOW_COMMAND_MS = 120_000;

/** `1`, `42`: digits only. `Number("1e3")`, `" 7"` and `"0x10"` are not accepted. */
function wholeNumber(text: string | undefined): number | undefined {
  return text !== undefined && /^[1-9]\d{0,8}$/.test(text) ? Number(text) : undefined;
}

/**
 * Validates one command against the v1 contract, sends it, and presents the outcome. Parse, send,
 * present: the rules live in the use case behind the runtime. A refusal (`COMMAND_REFUSED`) and a
 * usage error both end in a stable JSON document under `--json`.
 */
export async function runCommand(
  context: CliContext,
  command: Command,
  candidate: Readonly<Record<string, unknown>>,
  timeoutMs: number = context.timeoutMs,
): Promise<void> {
  const globals = command.optsWithGlobals<GlobalOptions>();
  const format = formatOf(globals);
  const parsed = commandSchema.safeParse({ schemaVersion: CONTRACT_SCHEMA_VERSION, ...candidate });
  if (!parsed.success) {
    context.emit(presentUsageError("invalid or missing command arguments", format));
    return;
  }
  const outcome = await context.sendCommand({
    socketPath: globals.socket ?? context.defaultSocketPath,
    timeoutMs: Math.max(context.timeoutMs, timeoutMs),
    command: parsed.data,
  });
  context.emit(
    outcome.ok
      ? presentSuccess(outcome.result, JSON.stringify(outcome.result), format)
      : presentFailure(outcome.error, format),
  );
}

function collect(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

/** The Coordinator's run commands: plan, dispatch, wait, pause, resume, deliver. */
export function registerRunCommands(program: Command, context: CliContext): void {
  program
    .command("rework")
    .description("Record Architect and PO rework decisions")
    .command("record")
    .requiredOption("--run <id>", "run id")
    .requiredOption(
      "--event <type>",
      "architect_solution_accepted, architect_no_solution or po_reopened",
    )
    .option("--intervention <id>", "accepted Architect intervention id")
    .option("--changes-business-or-cost", "the accepted solution changes business or cost")
    .option("--po-decision <id>", "approved request id")
    .action(
      async (
        options: {
          run: string;
          event: string;
          intervention?: string;
          changesBusinessOrCost?: boolean;
          poDecision?: string;
        },
        command: Command,
      ) => {
        await runCommand(context, command, {
          command: "rework.record",
          runId: options.run,
          event: {
            type: options.event,
            ...(options.event === "architect_solution_accepted"
              ? {
                  interventionId: options.intervention,
                  changesBusinessOrCost: options.changesBusinessOrCost ?? false,
                }
              : {}),
            ...(options.poDecision === undefined ? {} : { poDecisionId: options.poDecision }),
          },
        });
      },
    );
  program
    .command("retry")
    .description("Retry a failed step through the runtime rework and operational gates")
    .requiredOption("--run <id>", "run id")
    .requiredOption("--step <id>", "workflow step id")
    .option("--po-decision <id>", "approved request authorizing a blocked run to reopen")
    .action(
      async (options: { run: string; step: string; poDecision?: string }, command: Command) => {
        await runCommand(
          context,
          command,
          {
            command: "retry",
            runId: options.run,
            stepId: options.step,
            ...(options.poDecision === undefined ? {} : { poDecisionId: options.poDecision }),
          },
          SLOW_COMMAND_MS,
        );
      },
    );
  program
    .command("plan")
    .description("Start a run of a workflow for an imported Issue")
    .requiredOption("--issue <number>", "Issue number")
    .option("--workflow <id>", "workflow template id")
    .action(async (options: { issue: string; workflow?: string }, command: Command) => {
      await runCommand(context, command, {
        command: "plan",
        issueNumber: wholeNumber(options.issue),
        ...(options.workflow === undefined ? {} : { workflowId: options.workflow }),
      });
    });

  program
    .command("run")
    .description("Plan a run, then dispatch its first ready step (stops after that dispatch)")
    .requiredOption("--issue <number>", "Issue number")
    .option("--workflow <id>", "workflow template id")
    .option("--step <id>", "dispatch this step instead of the first ready one")
    .action(
      async (options: { issue: string; workflow?: string; step?: string }, command: Command) => {
        const globals = command.optsWithGlobals<GlobalOptions>();
        const format = formatOf(globals);
        const send = async (candidate: Readonly<Record<string, unknown>>, timeoutMs: number) => {
          const parsed = commandSchema.safeParse({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            ...candidate,
          });
          if (!parsed.success) return undefined;
          return context.sendCommand({
            socketPath: globals.socket ?? context.defaultSocketPath,
            timeoutMs: Math.max(context.timeoutMs, timeoutMs),
            command: parsed.data,
          });
        };
        const planned = await send(
          {
            command: "plan",
            issueNumber: wholeNumber(options.issue),
            ...(options.workflow === undefined ? {} : { workflowId: options.workflow }),
          },
          context.timeoutMs,
        );
        if (planned === undefined) {
          context.emit(presentUsageError("invalid or missing command arguments", format));
          return;
        }
        if (!planned.ok) {
          context.emit(presentFailure(planned.error, format));
          return;
        }
        const plan = planned.result as {
          runId?: string;
          steps?: readonly { stepId: string; status: string }[];
        };
        const stepId = options.step ?? plan.steps?.find((step) => step.status === "ready")?.stepId;
        if (stepId === undefined) {
          // The runtime owns readiness; with nothing ready there is no dispatch to ask it about.
          context.emit(
            presentFailure({ code: "COMMAND_REFUSED", message: "STEP_NOT_READY" }, format),
          );
          return;
        }
        const dispatched = await send({ command: "dispatch", runId: plan.runId, stepId }, 60_000);
        if (dispatched === undefined) {
          context.emit(presentUsageError("invalid or missing command arguments", format));
          return;
        }
        if (!dispatched.ok) {
          context.emit(presentFailure(dispatched.error, format));
          return;
        }
        const ids = {
          runId: plan.runId,
          stepId,
          attemptId: (dispatched.result as { attemptId?: string }).attemptId,
        };
        context.emit(
          presentSuccess(
            ids,
            `runId=${ids.runId ?? ""} stepId=${ids.stepId} attemptId=${ids.attemptId ?? ""}`,
            format,
          ),
        );
      },
    );

  program
    .command("dispatch")
    .description("Dispatch one ready step of a run to a worker")
    .requiredOption("--run <id>", "run id")
    .requiredOption("--step <id>", "workflow step id")
    .option("--notes <file>", "Coordinator notes only; the runtime builds the worker prompt")
    .action(async (options: { run: string; step: string; notes?: string }, command: Command) => {
      const notes =
        options.notes === undefined ? undefined : await context.readText?.(options.notes);
      if (options.notes !== undefined && notes === undefined) {
        context.emit(
          presentUsageError(
            "notes file must be bounded UTF-8 text",
            formatOf(command.optsWithGlobals<GlobalOptions>()),
          ),
        );
        return;
      }
      await runCommand(
        context,
        command,
        {
          command: "dispatch",
          runId: options.run,
          stepId: options.step,
          ...(notes === undefined ? {} : { notes }),
        },
        60_000,
      );
    });

  program
    .command("worker-report")
    .description("Read the recorded worker result and its verification outcome")
    .requiredOption("--attempt <id>", "attempt id returned by dispatch")
    .action(async (options: { attempt: string }, command: Command) => {
      await runCommand(context, command, { command: "worker-report", attemptId: options.attempt });
    });

  program
    .command("commit-worker")
    .description("Commit a stopped worker's allowed output paths without executing hooks")
    .requiredOption("--attempt <id>", "stopped attempt id")
    .requiredOption("--message-file <file>", "commit message file")
    .action(async (options: { attempt: string; messageFile: string }, command: Command) => {
      await runCommand(
        context,
        command,
        {
          command: "commit-worker",
          attemptId: options.attempt,
          message: await context.readText?.(options.messageFile),
        },
        SLOW_COMMAND_MS,
      );
    });

  program
    .command("review-comment")
    .description("Validate a review verdict against the live PR head and Issue AC before posting")
    .requiredOption("--pr <number>", "pull request number")
    .requiredOption("--file <file>", "independent review body")
    .action(async (options: { pr: string; file: string }, command: Command) => {
      await runCommand(
        context,
        command,
        {
          command: "review-comment",
          prNumber: wholeNumber(options.pr),
          body: await context.readText?.(options.file),
        },
        SLOW_COMMAND_MS,
      );
    });

  program
    .command("wait")
    .description("Wait until no worker of the run is running, or the timeout passes")
    .requiredOption("--run <id>", "run id")
    .option("--timeout <seconds>", "give up after this many seconds (1-3600)", "300")
    .action(async (options: { run: string; timeout: string }, command: Command) => {
      const seconds = wholeNumber(options.timeout);
      await runCommand(
        context,
        command,
        { command: "wait", runId: options.run, timeoutSeconds: seconds },
        (seconds ?? 0) * 1000 + 15_000,
      );
    });

  program
    .command("pause")
    .description("Pause a run at a checkpoint with its workers stopped")
    .requiredOption("--run <id>", "run id")
    .option("--reason <text>", "why (audit text, 1-500 characters)")
    .option("--reason-stdin", "read the reason from stdin (use this for text from a script)")
    .action(
      async (options: { run: string; reason?: string; reasonStdin?: true }, command: Command) => {
        const format = formatOf(command.optsWithGlobals<GlobalOptions>());
        if ((options.reason === undefined) === (options.reasonStdin === undefined)) {
          context.emit(
            presentUsageError("give exactly one of --reason and --reason-stdin", format),
          );
          return;
        }
        const reason = options.reasonStdin === true ? await context.readStdin?.() : options.reason;
        if (reason === undefined) {
          context.emit(presentUsageError("the reason could not be read as valid text", format));
          return;
        }
        await runCommand(
          context,
          command,
          { command: "pause", runId: options.run, reason: reason.trim() },
          60_000,
        );
      },
    );

  program
    .command("resume")
    .description("Resume a paused or interrupted run from its checkpoint")
    .requiredOption("--run <id>", "run id")
    .action(async (options: { run: string }, command: Command) => {
      await runCommand(context, command, { command: "resume", runId: options.run }, 60_000);
    });

  program
    .command("prepare-pr")
    .description("Open or recover the task PR for a finished run and save its mapping")
    .requiredOption("--run <id>", "run id")
    .requiredOption("--title <text>", "pull request title")
    .option("--evidence <text>", "one evidence line per AC in order (repeatable)", collect, [])
    .action(
      async (options: { run: string; title: string; evidence: string[] }, command: Command) => {
        await runCommand(
          context,
          command,
          {
            command: "prepare-pr",
            runId: options.run,
            title: options.title,
            evidence: options.evidence,
          },
          SLOW_COMMAND_MS,
        );
      },
    );

  program
    .command("deliver")
    .description("Merge the reviewed head of a finished run into develop and close the task")
    .requiredOption("--run <id>", "run id")
    .requiredOption("--pr <number>", "pull request number")
    .requiredOption("--head-sha <sha>", "the head the independent review examined")
    .option("--check <name>", "required check name (repeatable, at least one)", collect, [])
    .option("--min-approvals <count>", "minimum native approvals")
    .action(
      async (
        options: {
          run: string;
          pr: string;
          headSha: string;
          check: string[];
          minApprovals?: string;
        },
        command: Command,
      ) => {
        await runCommand(
          context,
          command,
          {
            command: "deliver",
            runId: options.run,
            prNumber: wholeNumber(options.pr),
            reviewedHeadSha: options.headSha,
            requiredChecks: options.check,
            ...(options.minApprovals === undefined
              ? {}
              : {
                  minimumNativeApprovals: /^\d{1,2}$/.test(options.minApprovals)
                    ? Number(options.minApprovals)
                    : -1,
                }),
          },
          SLOW_COMMAND_MS,
        );
      },
    );

  program
    .command("merge-release")
    .description("Merge the release PR (develop to main) on the head the PO approved")
    .requiredOption("--release <label>", "release label that prepared the release PR")
    .requiredOption("--pr <number>", "release pull request number")
    .requiredOption(
      "--head-sha <sha>",
      "the head the PO approved; the native merge is pinned to it",
    )
    .option("--check <name>", "required check name (repeatable)", collect, [])
    .action(
      async (
        options: { release: string; pr: string; headSha: string; check: string[] },
        command: Command,
      ) => {
        await runCommand(
          context,
          command,
          {
            command: "release.merge",
            release: options.release,
            prNumber: wholeNumber(options.pr),
            expectedHeadSha: options.headSha,
            requiredChecks: options.check,
          },
          SLOW_COMMAND_MS,
        );
      },
    );

  program
    .command("coordinator")
    .description("Coordinator session handoff")
    .command("switch")
    .description("Pause all runs so the PO can continue with another Coordinator profile")
    .requiredOption("--to <profile>", "label of the Windows Coordinator profile to use next")
    .action(async (options: { to: string }, command: Command) => {
      await runCommand(
        context,
        command,
        { command: "handoff", reason: "profile-switch", toProfile: options.to },
        60_000,
      );
    });
}
