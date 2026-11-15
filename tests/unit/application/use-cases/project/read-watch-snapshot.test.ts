import { describe, expect, it } from "vitest";
import type { Workflow } from "../../../../../src/application/contracts/workflow.ts";
import type { BoardTask } from "../../../../../src/application/ports/github-task-list.ts";
import type {
  OverviewAttempt,
  RunOverview,
} from "../../../../../src/application/ports/run-overview-reader.ts";
import {
  createWatchSnapshotReader,
  type QuotaInput,
  type WatchDeps,
} from "../../../../../src/application/use-cases/project/read-watch-snapshot.ts";
import {
  INITIAL_REWORK_STATE,
  type ReworkState,
} from "../../../../../src/domain/runs/rework-policy.ts";
import type { QuotaVerdict } from "../../../../../src/domain/profiles/quota-policy.ts";
import type { StepStatus } from "../../../../../src/domain/runs/step-run.ts";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const HASH = "f".repeat(64);

const step = (
  id: string,
  role: string,
  needs: string[] = [],
  skills: string[] = [],
  rules: string[] = [],
) => ({
  id,
  role,
  needs,
  skills,
  rules,
  capability_profile: "standard",
  output_contract: "step-result",
  required_checks: [],
});

const FEATURE: Workflow = {
  schema_version: 1,
  id: "feature",
  version: 1,
  selection: { task_types: ["feature"] },
  quality_policy: "default",
  steps: [
    step("implement", "developer", [], ["test-driven-development"], ["project-baseline"]),
    step("verify", "qa", ["implement"]),
    step("review", "reviewer", ["verify"]),
  ],
  gates: [{ id: "ready-to-merge", after: "review", policy: "merge" }],
};

const attempt = (overrides: Partial<OverviewAttempt> = {}): OverviewAttempt => ({
  stepId: "implement",
  attemptId: "att-1",
  status: "running",
  executor: "codex",
  profileId: "codex-b",
  model: "gpt-6.1-sol",
  effort: "medium",
  role: "developer",
  skills: ["test-driven-development"],
  rules: ["project-baseline"],
  startedAt: "2026-11-12T09:00:00.000Z",
  ...overrides,
});

const steps = (entries: Record<string, StepStatus>) =>
  Object.entries(entries).map(([stepId, status]) => ({ stepId, status }));

function run(overrides: Partial<RunOverview> = {}): RunOverview {
  return {
    runId: "run-1",
    taskId: "task-164",
    issueNumber: 164,
    status: "running",
    templateHash: HASH,
    rework: INITIAL_REWORK_STATE,
    steps: steps({ implement: "running" }),
    attempts: [attempt()],
    ...overrides,
  };
}

const board = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  number: 164,
  title: "Framework status and watch",
  state: "OPEN",
  status: "In Progress",
  planKey: "OMI-081",
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
});

function deps(overrides: Partial<WatchDeps> = {}): WatchDeps {
  return {
    runs: { listActive: () => [run()] },
    workflows: {
      byHash: (hash) => (hash === HASH ? { workflow: FEATURE, hash: HASH } : undefined),
    },
    board: { listTasks: () => Promise.resolve([board()]) },
    now: () => NOW,
    ...overrides,
  };
}

const first = async (overrides: Partial<WatchDeps> = {}) => {
  const snapshot = await readWatchSnapshot(deps(overrides));
  const card = snapshot.tasks[0];
  if (card === undefined) throw new Error("no card");
  return card;
};
const readWatchSnapshot = (input: WatchDeps) => createWatchSnapshotReader(input)();
const nodeState = (card: Awaited<ReturnType<typeof first>>, id: string) =>
  card.diagram.nodes.find((node) => node.id === id)?.state;
const reworkOf = (overrides: Partial<ReworkState>): ReworkState => ({
  ...INITIAL_REWORK_STATE,
  ...overrides,
});

describe("readWatchSnapshot", () => {
  it("reads the board once across twelve runtime polls within sixty seconds", async () => {
    let now = NOW;
    let boardReads = 0;
    let runtimeReads = 0;
    const shared = deps({
      now: () => now,
      board: {
        listTasks: () => {
          boardReads += 1;
          return Promise.resolve([board()]);
        },
      },
      runs: {
        listActive: () => {
          runtimeReads += 1;
          return [run()];
        },
      },
    });
    const read = createWatchSnapshotReader(shared);
    for (let poll = 0; poll < 12; poll += 1) {
      now = NOW + poll * 5000;
      expect((await read()).tasks[0]?.title).toBe("Framework status and watch");
    }
    expect(boardReads).toBe(1);
    expect(runtimeReads).toBe(12);
    now = NOW + 60_000;
    await read();
    expect(boardReads).toBe(2);
  });

  it("keeps the last good board tasks after a failed refresh and waits sixty seconds to retry", async () => {
    let now = NOW;
    let boardReads = 0;
    const shared = deps({
      now: () => now,
      board: {
        listTasks: () => {
          boardReads += 1;
          return boardReads === 2
            ? Promise.reject(new Error("BOARD_DOWN"))
            : Promise.resolve([board({ title: boardReads === 1 ? "Original" : "Updated" })]);
        },
      },
    });
    const read = createWatchSnapshotReader(shared);
    await read();
    now += 60_000;
    const failed = await read();
    expect(failed.board).toBe("unavailable");
    expect(failed.tasks[0]?.title).toBe("Original");
    now += 59_999;
    expect((await read()).tasks[0]?.title).toBe("Original");
    expect(boardReads).toBe(2);
    now += 1;
    expect((await read()).tasks[0]?.title).toBe("Updated");
    expect(boardReads).toBe(3);
  });
  it("shows a runtime-blocked run even without GitHub blockers", async () => {
    const card = await first({
      runs: { listActive: () => [run({ status: "blocked", attempts: [] })] },
      board: undefined,
    });
    expect(card.hold).toEqual({ kind: "blocked", by: [] });
    expect(card.diagram.nodes.find((node) => node.id === "implement")?.sub).toBe("blocked");
  });
  it("makes one card per active run with workflow, step, who, role, skills and rules", async () => {
    const snapshot = await readWatchSnapshot(deps());
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-11-12T10:00:00.000Z",
      board: "ok",
    });
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      runId: "run-1",
      issueNumber: 164,
      planKey: "OMI-081",
      title: "Framework status and watch",
      workflow: "feature",
      step: "implement",
      role: "developer",
      who: {
        executor: "codex",
        profileId: "codex-b",
        model: "gpt-6.1-sol",
        effort: "medium",
        startedAt: "2026-11-12T09:00:00.000Z",
      },
      loaded: {
        skills: ["test-driven-development"],
        rules: ["project-baseline"],
        mandatoryRules: null,
      },
    });
  });

  it("draws the steps and gates of the run's pinned workflow template", async () => {
    const card = await first();
    expect(card.diagram.nodes.map((node) => node.id)).toEqual([
      "implement",
      "verify",
      "review",
      "ready-to-merge",
    ]);
    expect(nodeState(card, "implement")).toBe("current");
    expect(nodeState(card, "verify")).toBe("todo");
  });

  it("has nobody working on a step with no running attempt", async () => {
    const card = await first({
      runs: {
        listActive: () => [
          run({
            status: "pending",
            steps: steps({ implement: "ready" }),
            attempts: [],
          }),
        ],
      },
    });
    expect(card.who).toBeNull();
    expect(card.loaded).toBeNull();
    expect(card.step).toBe("implement");
  });

  it("takes the role from the template step, and skills and rules from what the worker got", async () => {
    const card = await first({
      runs: {
        listActive: () => [
          run({
            steps: steps({ implement: "succeeded", verify: "running" }),
            attempts: [
              attempt({ stepId: "implement", status: "succeeded" }),
              attempt({
                stepId: "verify",
                attemptId: "att-2",
                role: "qa",
                skills: ["verification-before-completion"],
                rules: [],
              }),
            ],
          }),
        ],
      },
    });
    expect(card.step).toBe("verify");
    expect(card.role).toBe("qa");
    expect(card.loaded).toEqual({
      skills: ["verification-before-completion"],
      rules: [],
      mandatoryRules: null,
    });
    expect(card.skillCheck).toEqual({
      expected: [],
      missing: [],
      extra: [{ name: "verification-before-completion", template: null }],
    });
  });

  it("reports template skills the worker did not load", async () => {
    const card = await first({
      runs: { listActive: () => [run({ attempts: [attempt({ skills: [] })] })] },
    });
    expect(card.skillCheck?.missing).toEqual(["test-driven-development"]);
  });

  it("shows the rework counter and the rework edge from the runtime's controller state", async () => {
    const card = await first({
      runs: {
        listActive: () => [
          run({
            rework: reworkOf({ failedCycles: 1, countedCycleIds: ["c1"] }),
            steps: steps({ implement: "running", verify: "succeeded" }),
          }),
        ],
      },
    });
    expect(card.cycle).toEqual({
      phase: "before-architect",
      rework: 1,
      of: 2,
      architect: "none",
      failures: 1,
    });
    expect(card.diagram.reworkEdge).toEqual({ from: "review", to: "implement", failures: 1 });
  });

  it("calls the Architect from the 2nd failure and the PO after two more", async () => {
    const architect = await first({
      runs: {
        listActive: () => [
          run({
            rework: reworkOf({ phase: "architect", failedCycles: 2, countedCycleIds: ["a", "b"] }),
          }),
        ],
      },
    });
    expect(architect.diagram.nodes.find((n) => n.id === "architect")).toMatchObject({
      state: "current",
    });
    const askPo = await first({
      runs: {
        listActive: () => [
          run({
            status: "blocked",
            rework: reworkOf({
              phase: "blocked",
              failedCycles: 2,
              architectInterventionId: "arch-1",
              countedCycleIds: ["a", "b", "c", "d"],
            }),
          }),
        ],
      },
    });
    expect(askPo.diagram.nodes.map((n) => n.id)).toContain("ask-po");
    expect(askPo.cycle).toMatchObject({ phase: "escalate-po", failures: 4 });
  });

  it("shows Blocked when open blockers hold a task and no worker runs", async () => {
    const card = await first({
      runs: {
        listActive: () => [
          run({ status: "pending", steps: steps({ implement: "ready" }), attempts: [] }),
        ],
      },
      board: {
        listTasks: () =>
          Promise.resolve([
            board({
              blockers: [
                { number: 12, state: "OPEN" },
                { number: 13, state: "CLOSED" },
              ],
            }),
          ]),
      },
    });
    expect(card.hold).toEqual({ kind: "blocked", by: [12] });
    expect(card.diagram.nodes.find((n) => n.id === "implement")).toMatchObject({
      state: "blocked",
      sub: "blocked by #12",
    });
  });

  it("keeps the step current but warns when a worker runs on a blocked task", async () => {
    const card = await first({
      board: {
        listTasks: () => Promise.resolve([board({ blockers: [{ number: 12, state: "OPEN" }] })]),
      },
    });
    expect(card.hold).toBeNull();
    expect(nodeState(card, "implement")).toBe("current");
    expect(card.notes).toContain("worker runs but blocked by #12");
  });

  it("shows Waiting PO when the run waits for approval, ahead of Blocked", async () => {
    const card = await first({
      runs: {
        listActive: () => [
          run({
            status: "waiting_approval",
            steps: steps({ implement: "waiting_approval" }),
            attempts: [],
          }),
        ],
      },
      board: {
        listTasks: () => Promise.resolve([board({ blockers: [{ number: 12, state: "OPEN" }] })]),
      },
    });
    expect(card.hold).toEqual({ kind: "waiting-po" });
    expect(nodeState(card, "implement")).toBe("waiting-po");
  });

  it("shows Waiting PO when the rework budget is spent", async () => {
    const card = await first({
      runs: {
        listActive: () => [
          run({
            status: "blocked",
            rework: reworkOf({ phase: "blocked", failedCycles: 2 }),
            attempts: [],
            steps: steps({ implement: "failed" }),
          }),
        ],
      },
    });
    expect(card.hold).toEqual({ kind: "waiting-po" });
  });

  it("still shows the cards when the board cannot be read, without titles or blockers", async () => {
    const snapshot = await readWatchSnapshot(
      deps({ board: { listTasks: () => Promise.reject(new Error("BOARD_DOWN")) } }),
    );
    expect(snapshot.board).toBe("unavailable");
    expect(snapshot.tasks[0]).toMatchObject({ planKey: null, title: null, hold: null });
  });

  it("works without a board at all", async () => {
    const snapshot = await readWatchSnapshot(deps({ board: undefined }));
    expect(snapshot.board).toBe("not-configured");
    expect(snapshot.tasks).toHaveLength(1);
  });

  it("says so, and draws no diagram, when the pinned template is not in the catalog", async () => {
    const card = await first({ workflows: { byHash: () => undefined } });
    expect(card.diagram.nodes).toEqual([]);
    expect(card.workflow).toBeNull();
    expect(card.notes).toContain("workflow template of this run was not found");
  });

  it("lists a running task before the others, then by Issue number", async () => {
    const snapshot = await readWatchSnapshot(
      deps({
        runs: {
          listActive: () => [
            run({
              runId: "run-b",
              issueNumber: 20,
              attempts: [],
              steps: steps({ implement: "ready" }),
            }),
            run({ runId: "run-a", issueNumber: 30 }),
            run({
              runId: "run-c",
              issueNumber: 10,
              attempts: [],
              steps: steps({ implement: "ready" }),
            }),
          ],
        },
      }),
    );
    expect(snapshot.tasks.map((card) => card.issueNumber)).toEqual([30, 10, 20]);
  });

  it("has no cards when no run is active", async () => {
    expect((await readWatchSnapshot(deps({ runs: { listActive: () => [] } }))).tasks).toEqual([]);
  });
});

describe("readWatchSnapshot: worker per step", () => {
  const verifyRun = () =>
    run({
      steps: steps({ implement: "succeeded", verify: "running" }),
      attempts: [
        attempt({ stepId: "implement", status: "succeeded", attemptId: "att-1" }),
        attempt({
          stepId: "verify",
          attemptId: "att-2",
          executor: "claude",
          profileId: "claude-a",
          model: "sample-model",
          effort: "high",
          role: "qa",
          skills: [],
          rules: ["project-baseline"],
          startedAt: "2026-11-12T09:30:00.000Z",
        }),
      ],
    });

  it("names the role, step and elapsed time of the worker that is running, not the developer's", async () => {
    const card = await first({ runs: { listActive: () => [verifyRun()] } });
    expect(card.who).toEqual({
      executor: "claude",
      profileId: "claude-a",
      model: "sample-model",
      effort: "high",
      startedAt: "2026-11-12T09:30:00.000Z",
      step: "verify",
      role: "qa",
      elapsedSeconds: 1800,
    });
  });

  it("attaches the worker to the step it was dispatched for when two steps have attempts", async () => {
    const card = await first({
      runs: {
        listActive: () => [
          run({
            steps: steps({ implement: "running", verify: "succeeded" }),
            attempts: [
              attempt({ stepId: "verify", status: "succeeded", attemptId: "old" }),
              attempt({ stepId: "implement", attemptId: "new" }),
            ],
          }),
        ],
      },
    });
    expect(card.who?.step).toBe("implement");
    expect(card.who?.role).toBe("developer");
  });

  it("says which loaded rules are mandatory when the catalog says, and nothing otherwise", async () => {
    const withCatalog = await first({
      mandatoryRules: ["project-baseline"],
      runs: {
        listActive: () => [run({ attempts: [attempt({ rules: ["project-baseline", "x"] })] })],
      },
    });
    expect(withCatalog.loaded?.mandatoryRules).toEqual(["project-baseline"]);
    const without = await first();
    expect(without.loaded?.mandatoryRules).toBeNull();
  });

  it("clamps an attempt that appears to start in the future to zero elapsed seconds", async () => {
    const card = await first({
      runs: {
        listActive: () => [run({ attempts: [attempt({ startedAt: "2026-11-12T11:00:00Z" })] })],
      },
    });
    expect(card.who?.elapsedSeconds).toBe(0);
  });

  it("carries the drawn layout of the template with the current node marked", async () => {
    const card = await first();
    expect(card.layout.nodes.map((node) => node.id)).toEqual([
      "implement",
      "verify",
      "review",
      "ready-to-merge",
    ]);
    expect(card.layout.nodes.filter((node) => node.current).map((node) => node.id)).toEqual([
      "implement",
    ]);
    expect(card.layout.template.text).toBe("feature");
    expect(card.layout.tone).toBe("work");
  });

  it("has an empty layout, not an invented one, when the template is unavailable", async () => {
    const card = await first({ workflows: { byHash: () => undefined } });
    expect(card.layout.nodes).toEqual([]);
  });
});

describe("readWatchSnapshot: quota panel", () => {
  const verdict = (overrides: Partial<QuotaVerdict> = {}): QuotaVerdict => ({
    profileId: "p",
    freshness: "fresh",
    fiveHourLeft: 70,
    sevenDayLeft: 40,
    fiveHourResetsAt: null,
    score: 40,
    blocked: [],
    blockedUntil: null,
    resetCredits: null,
    modelWindows: [],
    ...overrides,
  });
  const THRESHOLDS = { minFiveHourLeftPercent: 10, minSevenDayLeftPercent: 10 };
  const source = (read: () => Promise<readonly QuotaInput[]>) => ({
    thresholds: THRESHOLDS,
    read,
  });
  const rowsOf = async (inputs: QuotaInput[]) =>
    (await readWatchSnapshot(deps({ quota: source(() => Promise.resolve(inputs)) }))).quota.rows;

  it("is not configured when the project has no quota source", async () => {
    const snapshot = await readWatchSnapshot(deps());
    expect(snapshot.quota).toEqual({ state: "not-configured", reason: null, rows: [] });
  });

  it("makes one row per profile, Claude then Codex then unknown tools, each by profile name", async () => {
    const rows = await rowsOf([
      { tool: "unknown", verdict: verdict({ profileId: "ghost" }) },
      { tool: "codex", verdict: verdict({ profileId: "codex-b" }) },
      { tool: "claude", verdict: verdict({ profileId: "claude-b" }) },
      { tool: "claude", verdict: verdict({ profileId: "claude-a" }) },
      { tool: "codex", verdict: verdict({ profileId: "codex-a" }) },
    ]);
    expect(rows.map((row) => `${row.tool}/${row.profile}`)).toEqual([
      "claude/claude-a",
      "claude/claude-b",
      "codex/codex-a",
      "codex/codex-b",
      "unknown/ghost",
    ]);
    expect(rows[0]).toMatchObject({
      fiveHourLeft: 70,
      sevenDayLeft: 40,
      severity: "ok",
      freshness: "fresh",
    });
  });

  it("grades severity with the shared rule: low under the threshold, critical under half or at the limit", async () => {
    const rows = await rowsOf([
      { tool: "claude", verdict: verdict({ profileId: "a", fiveHourLeft: 8 }) },
      { tool: "claude", verdict: verdict({ profileId: "b", fiveHourLeft: 4 }) },
      {
        tool: "claude",
        verdict: verdict({ profileId: "c", blocked: ["LIMIT_REACHED"] }),
      },
      { tool: "claude", verdict: verdict({ profileId: "d", sevenDayLeft: 9 }) },
    ]);
    expect(rows.map((row) => row.severity)).toEqual(["low", "critical", "critical", "low"]);
  });

  it("passes the five-hour reset through as a local HH:MM, and null when unknown", async () => {
    const at = new Date(NOW + 3_600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const rows = await rowsOf([
      {
        tool: "claude",
        verdict: verdict({ profileId: "a", fiveHourResetsAt: at.getTime() }),
      },
      { tool: "claude", verdict: verdict({ profileId: "b" }) },
    ]);
    expect(rows[0]?.resetText).toBe(`${pad(at.getHours())}:${pad(at.getMinutes())}`);
    expect(rows[1]?.resetText).toBeNull();
  });

  it("shows a profile with no reading as unknown, never as 0 or as fine", async () => {
    const rows = await rowsOf([
      {
        tool: "claude",
        verdict: verdict({
          fiveHourLeft: null,
          sevenDayLeft: null,
          freshness: "unknown",
          score: null,
        }),
      },
    ]);
    expect(rows[0]).toMatchObject({
      fiveHourLeft: null,
      sevenDayLeft: null,
      severity: "unknown",
    });
  });

  it("keeps the runtime cards and marks the quota unavailable when the read fails", async () => {
    const snapshot = await readWatchSnapshot(
      deps({ quota: source(() => Promise.reject(new Error("token sk-secret expired"))) }),
    );
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.quota).toEqual({ state: "unavailable", reason: "QUOTA_READ_FAILED", rows: [] });
    expect(JSON.stringify(snapshot)).not.toContain("sk-secret");
  });

  it("reads quota at most once a minute across polls", async () => {
    let now = NOW;
    let reads = 0;
    const read = createWatchSnapshotReader(
      deps({
        now: () => now,
        quota: source(() => {
          reads += 1;
          return Promise.resolve([{ tool: "codex" as const, verdict: verdict() }]);
        }),
      }),
    );
    for (let poll = 0; poll < 12; poll += 1) {
      await read();
      now += 4_000;
    }
    expect(reads).toBe(1);
    now += 60_000;
    await read();
    expect(reads).toBe(2);
  });
});
