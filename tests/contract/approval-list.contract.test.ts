import { expect, it } from "vitest";
import { commandSchema } from "../../src/application/contracts/command.ts";
import { APPROVAL_STATUSES } from "../../src/domain/approvals/approval.ts";

it("accepts approval.list with every domain status and rejects untrusted fields", () => {
  const command = { schemaVersion: 1, command: "approval.list" };
  expect(commandSchema.safeParse(command).success).toBe(true);
  for (const status of APPROVAL_STATUSES)
    expect(commandSchema.safeParse({ ...command, status }).success).toBe(true);
  expect(commandSchema.safeParse({ ...command, status: "unknown" }).success).toBe(false);
  expect(commandSchema.safeParse({ ...command, evidence: true }).success).toBe(false);
});
