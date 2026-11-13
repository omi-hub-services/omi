import type { Command } from "commander";
import {
  recordApprovalSchema,
  listApprovalsSchema,
  requestApprovalSchema,
} from "../../../application/contracts/approval.js";
import {
  presentFailure,
  presentSuccess,
  presentUsageError,
} from "../presenters/result-presenter.js";
import { formatOf } from "./command-context.js";
import type { CliContext, GlobalOptions } from "./command-context.js";

function approvalRequestText(result: unknown): string {
  const { id, version, status } = (result ?? {}) as Record<string, unknown>;
  return `approval request ${String(id)} version ${String(version)} ${String(status)}`;
}

export function registerApprovalCommands(program: Command, context: CliContext): void {
  const approvals = program.command("approvals").description("Versioned PO decisions");
  approvals
    .command("list")
    .description("list approval summaries without decision evidence")
    .option("--status <status>", "pending, approved, rejected, expired or invalidated")
    .action(async (options: { status?: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      const format = formatOf(globals);
      const parsed = listApprovalsSchema.safeParse({ status: options.status });
      if (!parsed.success) {
        context.emit(presentUsageError("invalid approval status", format));
        return;
      }
      const outcome = await context.sendCommand({
        socketPath: globals.socket ?? context.defaultSocketPath,
        timeoutMs: context.timeoutMs,
        command: { schemaVersion: 1, command: "approval.list", ...parsed.data },
      });
      context.emit(
        outcome.ok
          ? presentSuccess(outcome.result, JSON.stringify(outcome.result), format)
          : presentFailure(outcome.error, format),
      );
    });
  approvals
    .command("request <subject-id>")
    .description(
      "create a pending approval request for a trusted subject; it never records a decision",
    )
    .requiredOption("--kind <kind>", "business or deploy")
    .action(async (subjectId: string, options: { kind: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      const format = formatOf(globals);
      const parsed = requestApprovalSchema.safeParse({
        schemaVersion: 1,
        subjectId,
        kind: options.kind,
      });
      if (!parsed.success || (parsed.data.kind !== "business" && parsed.data.kind !== "deploy")) {
        context.emit(
          presentUsageError("invalid approval subject id or --kind business|deploy", format),
        );
        return;
      }
      const outcome = await context.sendCommand({
        socketPath: globals.socket ?? context.defaultSocketPath,
        timeoutMs: context.timeoutMs,
        command: { ...parsed.data, command: "approval.request" },
      });
      context.emit(
        outcome.ok
          ? presentSuccess(outcome.result, approvalRequestText(outcome.result), format)
          : presentFailure(outcome.error, format),
      );
    });
  approvals
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
