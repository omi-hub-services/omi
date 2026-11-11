import type { Command } from "commander";
import { recordApprovalSchema } from "../../../application/contracts/approval.js";
import {
  presentFailure,
  presentSuccess,
  presentUsageError,
} from "../presenters/result-presenter.js";
import { formatOf } from "./command-context.js";
import type { CliContext, GlobalOptions } from "./command-context.js";

export function registerApprovalCommands(program: Command, context: CliContext): void {
  program
    .command("approvals")
    .description("Versioned PO decisions")
    .command("decide <approval-id>")
    .requiredOption("--expected-version <version>", "expected request version")
    .requiredOption("--decision <decision>", "approved or rejected")
    .option("--reason <reason>", "reason (required for rejection)")
    .option(
      "--github-comment <id>",
      "verify an allowlisted GitHub actor's decision instead of prompting on the runtime terminal",
    )
    .action(
      async (
        approvalId: string,
        options: {
          expectedVersion: string;
          decision: string;
          reason?: string;
          githubComment?: string;
        },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals<GlobalOptions>();
        const format = formatOf(globals);
        const parsed = recordApprovalSchema.safeParse({
          schemaVersion: 1,
          approvalId,
          expectedVersion: /^\d+$/.test(options.expectedVersion)
            ? Number(options.expectedVersion)
            : -1,
          decision: options.decision,
          pathway: options.githubComment === undefined ? "cli" : "github",
          ...(options.reason === undefined ? {} : { reason: options.reason }),
          ...(options.githubComment === undefined ? {} : { evidenceRef: options.githubComment }),
        });
        if (!parsed.success) {
          context.emit(presentUsageError("invalid approval decision or version", format));
          return;
        }
        const outcome = await context.sendCommand({
          socketPath: globals.socket ?? context.defaultSocketPath,
          timeoutMs: Math.max(context.timeoutMs, 130_000),
          command: { ...parsed.data, command: "approval.decide" },
        });
        context.emit(
          outcome.ok
            ? presentSuccess(outcome.result, JSON.stringify(outcome.result), format)
            : presentFailure(outcome.error, format),
        );
      },
    );
}
