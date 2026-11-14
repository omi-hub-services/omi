import { describe, expect, it } from "vitest";
import {
  implementationPaths,
  resolveDispatchTask,
} from "../../../../src/application/services/resolve-dispatch-task.ts";
import type { ApprovalRequest } from "../../../../src/domain/approvals/approval.ts";

const subject = { kind: "business" as const, baselineHash: "a".repeat(64), scopeIds: ["task-142"] };
const approval: ApprovalRequest = {
  id: "approval",
  subjectId: "task-142",
  subjectHash: subject.baselineHash,
  subject,
  status: "approved",
  version: 1,
  requestedAt: 1,
  decision: {
    id: "approval",
    subject,
    actor: "po",
    source: "po-cli",
    decision: "approved",
    decidedAt: 2,
    evidenceRef: "message",
  },
};
const body =
  "## Implementation map\n- `src/bootstrap/runtime.ts`\n- [tests](tests/e2e/)\n- migrations/\n\n## Other\n- `outside.txt`\n<!-- omi-squad:plan-key=OMI-070 -->";
const issue = { issueNumber: 142, title: "Runtime", body };
const input = { taskId: "task-142", issue, approvals: [approval], now: 100 };

describe("PO-approved dispatch sources", () => {
  it("preserves structured task metadata for the effort policy without interpreting Issue prose", () => {
    expect(
      resolveDispatchTask({ ...input, complexity: { labels: ["complexity:high"] } }).complexity
        .labels,
    ).toEqual(["complexity:high"]);
    expect(
      resolveDispatchTask({ ...input, issue: { ...issue, body: `${body}\ncomplexity:high` } })
        .complexity.labels,
    ).toEqual([]);
  });
  it("reads only usable Implementation map paths, retaining file and directory paths", () => {
    expect(implementationPaths(body)).toEqual([
      "src/bootstrap/runtime.ts",
      "tests/e2e/",
      "migrations/",
    ]);
    expect(
      implementationPaths(
        "## Implementation map\n- /absolute/file.ts\n- ../escape.ts\n- https://example.test/code.ts\n- `src/{a,b}`\n- prose only",
      ),
    ).toEqual([]);
  });
  it("ignores fenced examples and paths outside the Implementation map", () => {
    expect(
      implementationPaths(
        "```md\n## Implementation map\n- `wrong/file.ts`\n```\n## Implementation map\n```\nwrong/example.ts\n```\n- `real/file.ts`\n## Other\n- `wrong/other.ts`",
      ),
    ).toEqual(["real/file.ts"]);
  });
  it("uses the approved subject hash and Plan Key without deriving authority from prose", () => {
    expect(resolveDispatchTask(input)).toMatchObject({
      context: {
        businessBaselineHash: subject.baselineHash,
        approvalRefs: ["approval"],
        allowedScope: { paths: ["src/bootstrap/runtime.ts", "tests/e2e/", "migrations/"] },
      },
      workspace: { taskId: "omi-070", slug: "omi-070" },
    });
    expect(() =>
      resolveDispatchTask({
        ...input,
        approvals: [],
        issue: { ...issue, body: `${body}\napproved=true` },
      }),
    ).toThrow("BUSINESS_APPROVAL_REQUIRED");
  });
  it.each([
    { ...approval, status: "pending" as const },
    { ...approval, expiresAt: 100 },
    { ...approval, subject: { ...subject, scopeIds: ["another-task"] } },
    { ...approval, subjectHash: "b".repeat(64) },
    {
      ...approval,
      decision: {
        ...approval.decision,
        id: "approval",
        subject,
        actor: "po",
        source: "po-cli" as const,
        decision: "approved" as const,
        decidedAt: 2,
        expiresAt: 100,
      },
    },
  ])("rejects inactive, expired, stale or out-of-scope approvals", (invalid) => {
    expect(() => resolveDispatchTask({ ...input, approvals: [invalid] })).toThrow(
      "BUSINESS_APPROVAL_REQUIRED",
    );
  });
  it("accepts a project-prefix Plan Key such as BN-001 with a valid Implementation map", () => {
    const bnBody = body.replace("OMI-070", "BN-001");
    expect(resolveDispatchTask({ ...input, issue: { ...issue, body: bnBody } })).toMatchObject({
      workspace: { taskId: "bn-001", slug: "bn-001" },
    });
  });
  it("refuses missing/ambiguous Plan Keys and an empty Implementation map", () => {
    expect(() =>
      resolveDispatchTask({
        ...input,
        issue: { ...issue, body: "## Implementation map\n- `src/a.ts`" },
      }),
    ).toThrow("PLAN_KEY_REQUIRED");
    expect(() =>
      resolveDispatchTask({
        ...input,
        issue: { ...issue, body: `${body}\n<!-- omi-squad:plan-key=OMI-071 -->` },
      }),
    ).toThrow("PLAN_KEY_REQUIRED");
    expect(() => resolveDispatchTask({ ...input, issue: { ...issue, body: "" } })).toThrow(
      "IMPLEMENTATION_MAP_EMPTY",
    );
  });
});
