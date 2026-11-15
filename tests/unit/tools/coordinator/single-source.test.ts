import { expect, it } from "vitest";
import { acceptanceCriteria } from "../../../../src/domain/tasks/acceptance-criteria.ts";
import { parseAcReviewLines } from "../../../../src/domain/delivery/acceptance-review.ts";
import { taskReadinessReasons } from "../../../../src/domain/tasks/readiness-gate.ts";
import { groupTasksByStatus } from "../../../../src/domain/tasks/next-task-policy.ts";
import { extractAcceptanceCriteria } from "../../../../tools/coordinator/acceptance-criteria.ts";
import { checkReview } from "../../../../tools/coordinator/review-verdict.ts";
import { issueReadinessReasons } from "../../../../tools/coordinator/issue-readiness.ts";
import { STATUS_ORDER } from "../../../../tools/coordinator/coordinator-settings.ts";

it("ignores an AC heading inside a fenced example in both readers", () => {
  const body =
    "````md\n## Acceptance criteria\n- [ ] example\n```\n- [ ] still example\n````\n## Acceptance criteria\n- [ ] real\n";
  expect(extractAcceptanceCriteria(body)).toEqual(acceptanceCriteria(body));
  expect(extractAcceptanceCriteria(body)).toEqual(["real"]);
});

it.each(["—", "–", "-", "--"])("accepts the framework's %s verdict separator", (dash) => {
  const line = `AC-1: met ${dash} evidence`;
  expect(parseAcReviewLines(line)[0]?.verdict).toBe("met");
  expect(
    checkReview(`**VERDICT:** PASS · **REVIEWED_HEAD:** \`${"a".repeat(40)}\`\n${line}`, {
      acCount: 1,
      prHead: "a".repeat(40),
    }).ok,
  ).toBe(true);
});

it("uses the same generic Plan Key readiness rule", () => {
  const task = {
    planKey: "APP-001",
    body: "## Acceptance criteria\n- [ ] works\n## Implementation map\n- `src/application/map.ts`\n<!-- omi-squad:plan-key=APP-001 -->",
    priority: "P1",
    workType: "Task",
    workflow: "feature",
    role: "Developer",
    area: "domain",
  };
  expect(issueReadinessReasons(task)).toEqual(taskReadinessReasons(task));
  expect(issueReadinessReasons(task)).toEqual([]);
});

it("uses the same complete board status order", () => {
  const tasks = [...STATUS_ORDER].reverse().map((status, number) => ({
    number,
    status,
    state: "OPEN" as const,
    workType: "Task",
    milestone: null,
    blockers: [],
    blockersTruncated: false,
    planKey: null,
    body: "",
    priority: null,
    workflow: null,
    role: null,
    area: null,
  }));
  expect(groupTasksByStatus(tasks).map((g) => g.status)).toEqual(STATUS_ORDER);
});

it.each(["tooling", "domain"])(
  "requires a framework counterpart for tooling paths (area %s)",
  (area) => {
    const task = {
      planKey: "OMI-001",
      body: "## Acceptance criteria\n- [ ] works\n## Implementation map\ntools/coordinator/flow.ts\n<!-- omi-squad:plan-key=OMI-001 -->",
      priority: "P1",
      workType: "Task",
      workflow: "feature",
      role: "Developer",
      area,
    };
    expect(taskReadinessReasons(task)).toContain(
      "missing ## Framework counterpart with module/template or reason",
    );
    expect(issueReadinessReasons(task)).toEqual(taskReadinessReasons(task));
    expect(
      taskReadinessReasons({
        ...task,
        body: `${task.body}\n## Framework counterpart\nsrc/domain/tasks/readiness-gate.ts`,
      }),
    ).toEqual([]);
  },
);

it("uses one repository maintenance permission policy from the framework", async () => {
  const framework =
    await import("../../../../src/infrastructure/executors/claude-code/claude-code-invocation.ts");
  const tooling = await import("../../../../tools/coordinator/worker-launch.ts");
  expect(framework).toHaveProperty("REPOSITORY_WORKER_ALLOWED_TOOLS", tooling.CLAUDE_ALLOWED_TOOLS);
  expect(framework).toHaveProperty("REPOSITORY_WORKER_DENIED_TOOLS", tooling.CLAUDE_DENIED_TOOLS);
});

it("allows tooling changes in a worker commit", async () => {
  const { judgeCommit } = await import("../../../../tools/coordinator/worker-commit.ts");
  expect(
    judgeCommit("task/omi-091-single-source", "task/omi-091-single-source", [
      "tools/coordinator/flow.ts",
    ]),
  ).toEqual({ kind: "commit" });
});

it("rejects duplicate review headers before a comment is posted", () => {
  const header = `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${"a".repeat(40)}\``;
  expect(
    checkReview(`${header}\n${header}\nAC-1: met — evidence`, {
      acCount: 1,
      prHead: "a".repeat(40),
    }).ok,
  ).toBe(false);
});

it("rejects a free-text worker claim without the framework result contract", async () => {
  const { stepResultSchema } = await import("../../../../src/application/contracts/result.ts");
  expect(stepResultSchema.safeParse("All checks passed").success).toBe(false);
  const report = await import("../../../../tools/coordinator/worker-report.ts");
  expect(report).toHaveProperty("validateWorkerResult");
  if ("validateWorkerResult" in report && typeof report.validateWorkerResult === "function") {
    expect(report.validateWorkerResult("All checks passed").success).toBe(false);
    expect(
      report.validateWorkerResult(
        JSON.stringify({
          schemaVersion: 1,
          runId: "repo-186",
          stepId: "implement",
          attemptId: "repo-186-implement-1",
          status: "succeeded",
          summary: "Evidence",
          artifacts: [],
          checks: [],
          skillsApplied: [],
          findings: [],
        }),
      ).success,
    ).toBe(true);
  }
});

it("refuses ticking from malformed or repeated AC evidence", async () => {
  const { parseAcLines, tickAcceptanceCriteria } =
    await import("../../../../tools/coordinator/acceptance-criteria.ts");
  const body = "## Acceptance criteria\n- [ ] one\n";
  expect(tickAcceptanceCriteria(body, parseAcLines("AC-1: met")).kind).toBe("refuse");
  expect(
    tickAcceptanceCriteria(body, parseAcLines("AC-1: met — evidence\nAC-1: met — duplicate")).kind,
  ).toBe("refuse");
});
