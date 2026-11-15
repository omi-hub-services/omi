import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import type { ApprovalDecisionSource } from "../../application/ports/approval-decision-source.js";

/** Runtime-owned terminal only: redirected stdin and caller-supplied actor flags cannot confirm. */
export function createInteractiveApprovalConfirmation(): ApprovalDecisionSource["verify"] {
  let confirming = false;
  return async (request, input) => {
    if (input.pathway !== "cli" || !process.stdin.isTTY || !process.stderr.isTTY || confirming)
      return undefined;
    confirming = true;
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const phrase = `${input.decision} ${request.id} ${request.subjectHash} ${String(request.version)}`;
      const answer = await terminal.question(
        `Approval subject: ${JSON.stringify(request.subject)}\nReason: ${JSON.stringify(input.reason ?? "")}\nType ${phrase} to confirm: `,
        { signal: AbortSignal.timeout(120_000) },
      );
      if (answer !== phrase) return undefined;
      return {
        approvalId: request.id,
        subjectHash: request.subjectHash,
        version: request.version,
        decision: input.decision,
        actor: userInfo().username,
        source: "po-cli",
        evidenceRef: `terminal:${request.id}:${String(request.version)}`,
      };
    } catch {
      return undefined;
    } finally {
      confirming = false;
      terminal.close();
    }
  };
}
