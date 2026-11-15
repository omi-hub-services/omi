import { z } from "zod";
import { gitShaSchema } from "../contracts/identifiers.js";

const execution = z.strictObject({
  revision: gitShaSchema,
  command: z.array(z.string().min(1)).min(1),
  exitCode: z.number().int().min(0),
});
const regressionEvidence = z.strictObject({ base: execution, head: execution });

/** Validates script output, never a reviewer's prose claim about red/green tests. */
export function validRegressionEvidence(input: unknown, base: string, head: string): boolean {
  const parsed = regressionEvidence.safeParse(input);
  if (!parsed.success) return false;
  const evidence = parsed.data;
  return (
    evidence.base.revision === base &&
    evidence.head.revision === head &&
    evidence.base.exitCode > 0 &&
    evidence.head.exitCode === 0 &&
    JSON.stringify(evidence.base.command) === JSON.stringify(evidence.head.command)
  );
}
