import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { recordApprovalSchema } from "../../application/contracts/approval.js";
import type { ApprovalDecisionSource } from "../../application/ports/approval-decision-source.js";

const execFileAsync = promisify(execFile);
const commentSchema = z.object({
  user: z.object({ login: z.string().min(1), type: z.literal("User") }),
  body: z.string().max(16384),
});
const decisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  approvalId: z.string().min(1),
  subjectHash: z.string().min(1),
  version: z.number().int().nonnegative(),
  decision: z.enum(["approved", "rejected"]),
  reason: recordApprovalSchema.shape.reason,
});

/** Read-back adapter, pinned to the configured repository; Issue prose is never interpreted. */
export function createGitHubApprovalDecisionSource(options: {
  readonly repository: string;
  readonly confirmCli: ApprovalDecisionSource["verify"];
  readonly readComment?: (endpoint: string) => Promise<unknown>;
}): ApprovalDecisionSource {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository))
    throw new Error("invalid repository");
  const readComment =
    options.readComment ??
    (async (endpoint: string): Promise<unknown> => {
      const { stdout } = await execFileAsync("gh", ["api", endpoint], {
        timeout: 10_000,
        maxBuffer: 65536,
      });
      return JSON.parse(stdout) as unknown;
    });
  return {
    async verify(request, input) {
      if (input.pathway === "cli") return options.confirmCli(request, input);
      // An API comment id, not a body supplied by a worker or an arbitrary URL/host.
      if (input.evidenceRef === undefined || !/^[1-9][0-9]{0,19}$/.test(input.evidenceRef))
        return undefined;
      try {
        const comment = commentSchema.safeParse(
          await readComment(`repos/${options.repository}/issues/comments/${input.evidenceRef}`),
        );
        if (!comment.success) return undefined;
        const body: unknown = JSON.parse(comment.data.body);
        const decision = decisionSchema.safeParse(body);
        if (!decision.success || decision.data.reason !== input.reason) return undefined;
        return {
          ...decision.data,
          actor: comment.data.user.login,
          source: "github-actor",
          evidenceRef: `github:${options.repository}:comment:${input.evidenceRef}`,
        };
      } catch {
        return undefined;
      }
    },
  };
}
