import type {
  CreateTaskRequest,
  GithubIntake,
  IntakeSnapshot,
} from "../../../../../src/application/ports/github-intake.ts";
import type { GithubTaskBoard } from "../../../../../src/application/ports/github-task-board.ts";
import type {
  IssueSpecFile,
  IssueSpecRead,
} from "../../../../../src/application/ports/issue-spec-file.ts";
import type { GatedStatus } from "../../../../../src/application/contracts/task-intake.ts";
import type { PromotionCandidate } from "../../../../../src/domain/tasks/promotion-policy.ts";

export const READY_BODY = [
  "## Mục tiêu",
  "Goal.",
  "## Phạm vi",
  "Scope.",
  "## Acceptance criteria",
  "- [ ] one",
  "## Dependencies",
  "None.",
  "<!-- omi-squad:plan-key=OMI-001 -->",
].join("\n");

export function task(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    number: 10,
    state: "OPEN",
    status: "Backlog",
    planKey: "OMI-001",
    body: READY_BODY,
    priority: "P1",
    workType: "Task",
    workflow: "feature",
    role: "Developer",
    area: "domain",
    milestone: "M1",
    blockers: [],
    blockersTruncated: false,
    ...overrides,
  };
}

export class FakeBoard implements GithubTaskBoard {
  readonly tasks = new Map<number, PromotionCandidate>();
  readonly writes: { issueNumber: number; status: GatedStatus }[] = [];
  constructor(tasks: readonly PromotionCandidate[] = []) {
    for (const t of tasks) this.tasks.set(t.number, t);
  }
  read(issueNumber: number) {
    return Promise.resolve(this.tasks.get(issueNumber));
  }
  listBacklog() {
    return Promise.resolve([...this.tasks.values()].filter((t) => t.status === "Backlog"));
  }
  setStatus(issueNumber: number, status: GatedStatus) {
    this.writes.push({ issueNumber, status });
    const current = this.tasks.get(issueNumber);
    if (current) this.tasks.set(issueNumber, { ...current, status });
    return Promise.resolve();
  }
}

export const SPEC_BODY = [
  "## Mục tiêu",
  "Goal.",
  "## Phạm vi",
  "Scope.",
  "## Acceptance criteria",
  "- [ ] one",
  "## Dependencies",
  "None.",
  "## Framework counterpart",
  "src/domain/tasks/issue-spec-policy.ts",
].join("\n");

export const FRONTMATTER = {
  title: "Validate a task",
  priority: "P1",
  workType: "Task",
  workflow: "feature",
  role: "Developer",
  area: "tooling",
  milestone: "M1",
  epic: 1,
  blockedBy: [2],
};

export class FakeSpecFile implements IssueSpecFile {
  readonly recorded: string[] = [];
  result: IssueSpecRead;
  constructor(result: IssueSpecRead = { kind: "ok", frontmatter: FRONTMATTER, body: SPEC_BODY }) {
    this.result = result;
  }
  read() {
    return Promise.resolve(this.result);
  }
  recordPlanKeyMarker(marker: string) {
    this.recorded.push(marker);
    return Promise.resolve();
  }
}

const option = (id: string, name: string) => ({ id, name });
export function snapshot(overrides: Partial<IntakeSnapshot> = {}): IntakeSnapshot {
  return {
    projectId: "PVT_1",
    fields: [
      {
        id: "F_status",
        name: "Status",
        dataType: "SINGLE_SELECT",
        options: [option("S1", "Backlog")],
      },
      {
        id: "F_priority",
        name: "Priority",
        dataType: "SINGLE_SELECT",
        options: [option("P1", "P1")],
      },
      {
        id: "F_type",
        name: "Work Type",
        dataType: "SINGLE_SELECT",
        options: [option("T1", "Task")],
      },
      {
        id: "F_wf",
        name: "Workflow",
        dataType: "SINGLE_SELECT",
        options: [option("W1", "feature")],
      },
      {
        id: "F_role",
        name: "Role",
        dataType: "SINGLE_SELECT",
        options: [option("R1", "Developer")],
      },
      { id: "F_area", name: "Area", dataType: "SINGLE_SELECT", options: [option("A1", "tooling")] },
      { id: "F_key", name: "Plan Key", dataType: "TEXT", options: [] },
    ],
    issues: [
      { number: 1, id: 101, title: "[EP-001] Epic", body: "x\n<!-- omi-squad:plan-key=EP-001 -->" },
      {
        number: 2,
        id: 102,
        title: "[OMI-005] Done",
        body: "y\n<!-- omi-squad:plan-key=OMI-005 -->",
      },
    ],
    projectPlanKeys: ["EP-001", "OMI-005"],
    milestones: [{ number: 7, title: "M1" }],
    ...overrides,
  };
}

export class FakeIntake implements GithubIntake {
  readonly created: CreateTaskRequest[] = [];
  failCreate = false;
  data: IntakeSnapshot;
  constructor(data: IntakeSnapshot = snapshot()) {
    this.data = data;
  }
  snapshot() {
    return Promise.resolve(this.data);
  }
  createTask(request: CreateTaskRequest) {
    if (this.failCreate) return Promise.reject(new Error("remote failed"));
    this.created.push(request);
    return Promise.resolve({ number: 50 });
  }
}
