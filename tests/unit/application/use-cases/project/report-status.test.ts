import { describe, expect, it } from "vitest";
import type { BoardTask } from "../../../../../src/application/ports/github-task-list.ts";
import type { OpenPull } from "../../../../../src/application/ports/open-pull-reader.ts";
import type {
  OverviewAttempt,
  RunOverview,
} from "../../../../../src/application/ports/run-overview-reader.ts";
import {
  reportStatus,
  type StatusDeps,
} from "../../../../../src/application/use-cases/project/report-status.ts";
import { INITIAL_REWORK_STATE } from "../../../../../src/domain/runs/rework-policy.ts";
import type { QuotaVerdict } from "../../../../../src/domain/profiles/quota-policy.ts";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const HEAD = "a".repeat(40);

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    number: 10,
    title: "Task ten",
    state: "OPEN",
    status: "Ready",
    planKey: "OMI-010",
    body: "",
    priority: "P1",
    workType: "Task",
    workflow: "feature",
    role: "Developer",
    area: "tooling",
    milestone: "M1",
    blockers: [],
    blockersTruncated: false,
    ...overrides,
  };
}

function pull(overrides: Partial<OpenPull> = {}): OpenPull {
  return {
    number: 50,
    title: "feat: ten",
    headRef: "task/omi-010-x",
    headSha: HEAD,
    draft: false,
    body: "Summary\n\nIssue: #10\n",
    ...overrides,
  };
}

const ATTEMPT: OverviewAttempt = {
  stepId: "implement",
  attemptId: "att-1",
  status: "running",
  executor: "codex",
  profileId: "codex-b",
  model: "gpt-6.1-sol",
  effort: "medium",
  role: "developer",
  skills: ["minimal-change"],
  rules: ["project-baseline"],
  startedAt: "2026-11-12T09:00:00.000Z",
};

function run(overrides: Partial<RunOverview> = {}): RunOverview {
  return {
    runId: "run-1",
    taskId: "task-10",
    issueNumber: 10,
    status: "running",
    templateHash: "h".repeat(64),
    rework: INITIAL_REWORK_STATE,
    steps: [{ stepId: "implement", status: "running" }],
    attempts: [ATTEMPT],
    ...overrides,
  };
}

function deps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    board: { listTasks: () => Promise.resolve([task()]) },
    pulls: { listOpen: () => Promise.resolve([]) },
    checks: { checks: () => Promise.resolve([]) },
    reviews: { latest: () => undefined },
    runs: { listActive: () => [] },
    repository: "acme/app",
    now: () => NOW,
    ...overrides,
  };
}

describe("reportStatus", () => {
  it("does not suggest a Ready task that already has an active runtime run", async () => {
    const report = await reportStatus(
      deps({
        board: { listTasks: () => Promise.resolve([task(), task({ number: 11 })]) },
        runs: { listActive: () => [run()] },
      }),
    );
    expect(report.next?.number).toBe(11);
    expect(report.ready.map((task) => task.number)).toEqual([11]);
  });
  it("carries a schema version and the time it was made", async () => {
    expect(await reportStatus(deps())).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-11-12T10:00:00.000Z",
    });
  });

  it("lists open tasks by Project Status, Epics and closed tasks left out", async () => {
    const report = await reportStatus(
      deps({
        board: {
          listTasks: () =>
            Promise.resolve([
              task({ number: 1, status: "Backlog" }),
              task({ number: 2, status: "Ready" }),
              task({ number: 3, status: "Done", state: "CLOSED" }),
              task({ number: 4, status: "Ready", workType: "Epic" }),
            ]),
        },
      }),
    );
    expect(report.statuses.map((g) => [g.status, g.tasks.map((t) => t.number)])).toEqual([
      ["Backlog", [1]],
      ["Ready", [2]],
    ]);
    expect(report.statuses[1]?.tasks[0]).toEqual({
      number: 2,
      title: "Task ten",
      planKey: "OMI-010",
      priority: "P1",
    });
  });

  it("lists unblocked Ready tasks and suggests the first as the next task", async () => {
    const report = await reportStatus(
      deps({
        board: {
          listTasks: () =>
            Promise.resolve([
              task({ number: 5, priority: "P2" }),
              task({ number: 6, blockers: [{ number: 5, state: "OPEN" }] }),
              task({ number: 7, priority: "P0" }),
            ]),
        },
      }),
    );
    expect(report.ready.map((t) => t.number)).toEqual([7, 5]);
    expect(report.next?.number).toBe(7);
  });

  it("has no suggested next task when nothing is unblocked and Ready", async () => {
    const report = await reportStatus(
      deps({ board: { listTasks: () => Promise.resolve([task({ status: "Backlog" })]) } }),
    );
    expect(report.next).toBeNull();
    expect(report.ready).toEqual([]);
  });

  it("shows an open PR with its task, its checks and the recorded review of the head", async () => {
    const report = await reportStatus(
      deps({
        pulls: { listOpen: () => Promise.resolve([pull()]) },
        checks: {
          checks: () =>
            Promise.resolve([
              { name: "ci", headSha: HEAD, status: "passed" as const },
              { name: "lint", headSha: HEAD, status: "passed" as const },
            ]),
        },
        reviews: { latest: () => ({ verdict: "pass", headSha: HEAD }) },
      }),
    );
    expect(report.pulls).toEqual([
      {
        number: 50,
        title: "feat: ten",
        headSha: HEAD,
        draft: false,
        issueNumber: 10,
        checks: { summary: "pass", passed: 2, failed: 0, pending: 0 },
        review: "pass",
      },
    ]);
  });

  it("summarises failing and pending checks, a failure first", async () => {
    const observed = (status: "passed" | "failed" | "pending", name: string) => ({
      name,
      headSha: HEAD,
      status,
    });
    const summary = async (statuses: ("passed" | "failed" | "pending")[]) =>
      (
        await reportStatus(
          deps({
            pulls: { listOpen: () => Promise.resolve([pull()]) },
            checks: {
              checks: () => Promise.resolve(statuses.map((s, i) => observed(s, `c${String(i)}`))),
            },
          }),
        )
      ).pulls[0]?.checks.summary;
    expect(await summary([])).toBe("none");
    expect(await summary(["passed", "pending"])).toBe("pending");
    expect(await summary(["pending", "failed", "passed"])).toBe("fail");
  });

  it("calls a review of another head stale and a missing review none", async () => {
    const reviewOf = async (latest: StatusDeps["reviews"]["latest"]) =>
      (
        await reportStatus(
          deps({ pulls: { listOpen: () => Promise.resolve([pull()]) }, reviews: { latest } }),
        )
      ).pulls[0]?.review;
    expect(await reviewOf(() => ({ verdict: "pass", headSha: "b".repeat(40) }))).toBe("stale");
    expect(await reviewOf(() => ({ verdict: "fail", headSha: HEAD }))).toBe("fail");
    expect(await reviewOf(() => undefined)).toBe("none");
  });

  it("does not guess the task of a PR that has no single Issue line", async () => {
    const report = await reportStatus(
      deps({
        pulls: {
          listOpen: () =>
            Promise.resolve([pull({ body: "Issue: #1\nIssue: #2\n" }), pull({ body: "" })]),
        },
      }),
    );
    expect(report.pulls.map((p) => p.issueNumber)).toEqual([null, null]);
  });

  it("lists running workers from the runtime state, not finished attempts", async () => {
    const overview = run({
      steps: [
        { stepId: "analyze", status: "succeeded" },
        { stepId: "implement", status: "running" },
      ],
      attempts: [
        { ...ATTEMPT, stepId: "analyze", attemptId: "att-0", status: "succeeded" },
        ATTEMPT,
      ],
    });
    const report = await reportStatus(deps({ runs: { listActive: () => [overview] } }));
    expect(report.workers).toEqual([
      {
        runId: "run-1",
        issueNumber: 10,
        stepId: "implement",
        role: "developer",
        executor: "codex",
        profileId: "codex-b",
        model: "gpt-6.1-sol",
        startedAt: "2026-11-12T09:00:00.000Z",
      },
    ]);
  });

  it("reports quota per profile, and null when quota is not configured", async () => {
    expect((await reportStatus(deps())).quota).toBeNull();
    const verdict: QuotaVerdict = {
      profileId: "claude-a",
      freshness: "fresh",
      fiveHourLeft: 5,
      sevenDayLeft: 70,
      score: 5,
      blocked: ["FIVE_HOUR_BELOW_THRESHOLD"],
      blockedUntil: Date.parse("2026-11-12T12:00:00Z"),
      resetCredits: null,
      modelWindows: [],
    };
    const report = await reportStatus(
      deps({ quota: () => Promise.resolve(new Map([["claude-a", verdict]])) }),
    );
    expect(report.quota).toEqual([
      {
        profileId: "claude-a",
        freshness: "fresh",
        fiveHourLeft: 5,
        sevenDayLeft: 70,
        blocked: ["FIVE_HOUR_BELOW_THRESHOLD"],
        blockedUntil: "2026-11-12T12:00:00.000Z",
      },
    ]);
  });

  it("lets a failing GitHub read fail the report instead of showing an empty board", async () => {
    await expect(
      reportStatus(deps({ board: { listTasks: () => Promise.reject(new Error("BOARD_DOWN")) } })),
    ).rejects.toThrow("BOARD_DOWN");
  });
});
