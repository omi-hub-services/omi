import { beforeEach, describe, expect, it } from "vitest";
import type { InspectedProject } from "../../../src/application/contracts/project-initialization.ts";
import { IntakeError } from "../../../src/application/ports/github-intake.ts";
import { TaskBoardError } from "../../../src/application/ports/github-task-board.ts";
import { createIssueFromSpec } from "../../../src/application/use-cases/tasks/create-issue-from-spec.ts";
import { promoteTask } from "../../../src/application/use-cases/tasks/promote-task.ts";
import { setTaskStatus } from "../../../src/application/use-cases/tasks/set-task-status.ts";
import { createGithubIntake } from "../../../src/infrastructure/github/github-intake.ts";
import { createGithubProjectReader } from "../../../src/infrastructure/github/github-project-reader.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import { createGithubTaskBoard } from "../../../src/infrastructure/github/github-task-board.ts";
import type { GithubTransport } from "../../../src/infrastructure/github/github-transport.ts";
import {
  FakeSpecFile,
  FRONTMATTER,
  SPEC_BODY,
} from "../../unit/application/use-cases/tasks/intake-fakes.ts";
import { FakeGithubBoard } from "./fake-github-board.ts";

const options = (names: readonly string[]) =>
  names.map((name) => ({ id: `opt_${name.replace(/\W/g, "")}`, name }));
const select = (name: string, values: readonly string[]) => ({
  id: `F_${name.replace(/\W/g, "")}`,
  name,
  dataType: "SINGLE_SELECT",
  options: options(values),
});
const PROJECT: InspectedProject = {
  id: "PVT_1",
  number: 1,
  title: "delivery",
  owner: { id: "O_1", login: "acme", type: "Organization" },
  fields: [
    select("Status", ["Backlog", "Ready", "In Progress", "Done"]),
    select("Priority", ["P0", "P1", "P2"]),
    select("Work Type", ["Task", "Epic"]),
    select("Workflow", ["feature", "docs"]),
    select("Role", ["Developer", "Reviewer"]),
    select("Area", ["tooling", "runtime"]),
    { id: "F_PlanKey", name: "Plan Key", dataType: "TEXT", options: [] },
  ],
};
const COORDINATES = {
  repository: { owner: "acme", name: "app" },
  project: { owner: "acme", number: 1 },
};

const READY_FIELDS = {
  Status: "Backlog",
  Priority: "P1",
  "Work Type": "Task",
  Workflow: "feature",
  Role: "Developer",
  Area: "tooling",
};
const readyBody = (key: string) =>
  `## Acceptance criteria\n- [ ] one\n## Implementation map\n- src/application/map.ts\n\n<!-- omi-squad:plan-key=${key} -->\n## Framework counterpart\nsrc/domain/tasks/readiness-gate.ts\n`;

let github: FakeGithubBoard;

function adapters(transport: GithubTransport = github) {
  const client = createGithubRestClient({
    transport,
    now: () => 0,
    random: () => 0,
    sleep: () => Promise.resolve(),
  });
  const projects = createGithubProjectReader(client);
  const deps = { client, projects, ...COORDINATES };
  return { intake: createGithubIntake(deps), board: createGithubTaskBoard(deps) };
}

beforeEach(() => {
  github = new FakeGithubBoard(PROJECT);
  github.milestones.push({ number: 7, title: "M1" });
  // An Epic, a finished task that holds OMI-005 and a pull request that must not consume a key.
  github.addIssue(
    { number: 1, id: 101, title: "[EP-001] Epic", body: "<!-- omi-squad:plan-key=EP-001 -->" },
    { "Plan Key": "EP-001", "Work Type": "Epic" },
  );
  github.addIssue(
    { number: 2, id: 102, title: "[OMI-005] Done", body: readyBody("OMI-005"), state: "CLOSED" },
    { ...READY_FIELDS, Status: "Done", "Plan Key": "OMI-005" },
  );
  github.pullRequestNumbers.push(3);
});

describe("GithubIntake with the use case (fake GitHub)", () => {
  it("previews the next key and performs no write without --apply", async () => {
    const { intake } = adapters();
    const spec = new FakeSpecFile();
    const result = await createIssueFromSpec({ spec, intake }, { prefix: "OMI", apply: false });
    expect(result).toMatchObject({ kind: "preview", plan: { planKey: "OMI-006" } });
    expect(github.writes).toEqual([]);
    expect(spec.recorded).toEqual([]);
  });

  it("creates the Issue, joins the Project, sets every field, then links epic and blocker", async () => {
    const { intake } = adapters();
    const spec = new FakeSpecFile();
    const result = await createIssueFromSpec({ spec, intake }, { prefix: "OMI", apply: true });
    expect(result).toMatchObject({
      kind: "created",
      plan: { planKey: "OMI-006" },
      issueNumber: 100,
    });
    expect(github.writes).toEqual([
      "create issue 100",
      "add item PVTI_100",
      "set Priority=P1 on PVTI_100",
      "set Work Type=Task on PVTI_100",
      "set Workflow=feature on PVTI_100",
      "set Role=Developer on PVTI_100",
      "set Area=tooling on PVTI_100",
      "set Status=Backlog on PVTI_100",
      "set Plan Key=OMI-006 on PVTI_100",
      "sub_issue 1 <- 1100",
      "blocked_by 100 <- 2",
    ]);
    const created = github.issues.find((i) => i.number === 100);
    expect(created).toMatchObject({
      title: "[OMI-006] Validate a task",
      milestone: "M1",
      blockedBy: [2],
    });
    expect(created?.body.match(/plan-key=OMI-006/g)).toHaveLength(1);
    expect(github.subIssues).toEqual([{ epic: 1, subIssueId: 1100 }]);
    expect(spec.recorded).toEqual(["<!-- omi-squad:plan-key=OMI-006 -->"]);
  });

  it("does not create a second Issue when the saved marker already exists on one", async () => {
    const { intake } = adapters();
    const first = new FakeSpecFile();
    await createIssueFromSpec({ spec: first, intake }, { prefix: "OMI", apply: true });
    const writes = github.writes.length;
    const retry = new FakeSpecFile({
      kind: "ok",
      frontmatter: FRONTMATTER,
      body: `${SPEC_BODY}\n\n${first.recorded[0] ?? ""}\n`,
    });
    expect(
      await createIssueFromSpec({ spec: retry, intake }, { prefix: "OMI", apply: true }),
    ).toEqual({
      kind: "exists",
      planKey: "OMI-006",
      issueNumber: 100,
    });
    expect(github.writes).toHaveLength(writes);
  });

  it("reads closed Issues, skips pull requests and reads every page", async () => {
    github.pageSize = 1;
    const { intake } = adapters();
    const snapshot = await intake.snapshot();
    expect(snapshot.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(snapshot.projectPlanKeys).toEqual(["EP-001", "OMI-005"]);
    expect(snapshot.milestones).toEqual([{ number: 7, title: "M1" }]);
    expect(snapshot.projectId).toBe("PVT_1");
    expect(snapshot.fields.map((f) => f.name)).toContain("Plan Key");
  });

  it("refuses an answer it cannot read instead of allocating from partial data", async () => {
    const broken: GithubTransport = {
      send: (request) =>
        request.path.startsWith("repos/acme/app/issues?")
          ? Promise.resolve({ status: 200, headers: {}, body: JSON.stringify({ not: "a list" }) })
          : github.send(request),
    };
    await expect(adapters(broken).intake.snapshot()).rejects.toBeInstanceOf(IntakeError);
  });
});

describe("GithubTaskBoard with promote and status (fake GitHub)", () => {
  function backlog(
    number: number,
    extra: Partial<Parameters<FakeGithubBoard["addIssue"]>[0]> = {},
  ) {
    github.addIssue(
      { number, body: readyBody(`OMI-0${String(number)}`), milestone: "M1", ...extra },
      { ...READY_FIELDS, "Plan Key": `OMI-0${String(number)}` },
    );
  }

  it("reads fields, milestone and blockers of an Issue on the Project", async () => {
    backlog(20, { blockedBy: [2] });
    expect(await adapters().board.read(20)).toMatchObject({
      number: 20,
      state: "OPEN",
      status: "Backlog",
      planKey: "OMI-020",
      priority: "P1",
      workType: "Task",
      workflow: "feature",
      role: "Developer",
      area: "tooling",
      milestone: "M1",
      blockers: [{ number: 2, state: "CLOSED" }],
      blockersTruncated: false,
    });
  });

  it("answers undefined for an Issue that is missing or not on the Project", async () => {
    github.addIssue({ number: 21 });
    const { board } = adapters();
    expect(await board.read(21)).toBeUndefined();
    expect(await board.read(999)).toBeUndefined();
  });

  it("marks blockers truncated when GitHub knows of more than it returned", async () => {
    backlog(22, { blockedBy: [2], blockersTotal: 5 });
    expect(await adapters().board.read(22)).toMatchObject({ blockersTruncated: true });
  });

  it("reads more than 50 closed blockers without marking them truncated", async () => {
    const ids = Array.from({ length: 60 }, (_, k) => 100 + k);
    for (const number of ids) github.addIssue({ number, state: "CLOSED" });
    backlog(40, { blockedBy: ids });
    const { board } = adapters();
    expect(await board.read(40)).toMatchObject({ blockersTruncated: false });
    expect((await board.read(40))?.blockers).toHaveLength(60);
    const listed = (await board.listBacklog()).find((t) => t.number === 40);
    expect(listed).toMatchObject({ blockersTruncated: false });
  });

  it("still marks more than 100 blockers truncated and open blockers open", async () => {
    const ids = Array.from({ length: 101 }, (_, k) => 200 + k); // 200..300
    for (const number of ids) github.addIssue({ number, state: "CLOSED" });
    backlog(41, { blockedBy: ids });
    expect(await adapters().board.read(41)).toMatchObject({ blockersTruncated: true });
    github.addIssue({ number: 150 });
    backlog(42, { blockedBy: [200, 150] });
    expect((await adapters().board.read(42))?.blockers).toContainEqual({
      number: 150,
      state: "OPEN",
    });
  });

  it("lists only Backlog Issues, across pages", async () => {
    github.pageSize = 1;
    backlog(23);
    backlog(24);
    const { board } = adapters();
    expect((await board.listBacklog()).map((t) => t.number).sort()).toEqual([23, 24]);
  });

  it("lists every Issue on the Project with title, status and blockers, across pages", async () => {
    github.pageSize = 1;
    backlog(25);
    github.addIssue(
      { number: 26, title: "Closed task", state: "CLOSED", body: readyBody("OMI-026") },
      { ...READY_FIELDS, Status: "Done", "Plan Key": "OMI-026" },
    );
    backlog(27, { blockedBy: [25] });
    github.addIssue({ number: 28 }); // an Issue that is not on the Project is not listed
    const tasks = await adapters().board.listTasks();
    // Issues 1 and 2 are the fixture's own Project items.
    expect(tasks.map((t) => t.number).filter((n) => n >= 25)).toEqual([25, 26, 27]);
    expect(tasks.find((t) => t.number === 26)).toMatchObject({
      title: "Closed task",
      state: "CLOSED",
      status: "Done",
    });
    expect(tasks.find((t) => t.number === 27)).toMatchObject({
      title: "Issue 27",
      status: "Backlog",
      blockers: [{ number: 25, state: "OPEN" }],
    });
  });

  it("promotes the first eligible Backlog Issue and changes only its Status", async () => {
    github.pageSize = 1;
    backlog(30, { blockedBy: [31] });
    backlog(31); // open blocker of 30
    backlog(32);
    const { board } = adapters();
    expect(await promoteTask({ board }, { dryRun: false })).toEqual({
      kind: "promoted",
      issueNumber: 31,
    });
    expect(github.writes).toEqual(["set Status=Ready on PVTI_31"]);
    expect(await promoteTask({ board }, { issueNumber: 30, dryRun: false })).toEqual({
      kind: "refused",
      reason: "#30: blocked by #31",
    });
    // 31 is Ready, still open: 30 stays blocked; 32 is the next Backlog pick.
    expect(await promoteTask({ board }, { dryRun: false })).toEqual({
      kind: "promoted",
      issueNumber: 32,
    });
  });

  it("refuses the transition and writes nothing when the Project fields are incomplete", async () => {
    github.addIssue(
      { number: 40, body: readyBody("OMI-040") },
      { Status: "Backlog", "Plan Key": "OMI-040" },
    );
    const { board } = adapters();
    const result = await setTaskStatus({ board }, { issueNumber: 40, status: "In Progress" });
    expect(result).toMatchObject({ kind: "refused" });
    expect(result.kind === "refused" && result.reasons).toEqual([
      "missing Priority",
      "missing Work Type",
      "missing Workflow",
      "missing Role",
      "missing Area",
    ]);
    expect(github.writes).toEqual([]);
  });

  it("sets In Progress on a ready Issue", async () => {
    backlog(41);
    const { board } = adapters();
    await setTaskStatus({ board }, { issueNumber: 41, status: "In Progress" });
    expect((await board.read(41))?.status).toBe("In Progress");
  });

  it("throws when the Project has no option for the status", async () => {
    backlog(42);
    const withoutReady: InspectedProject = {
      ...PROJECT,
      fields: PROJECT.fields.map((f) =>
        f.name === "Status" ? { ...f, options: f.options.filter((o) => o.name !== "Ready") } : f,
      ),
    };
    const board = new FakeGithubBoard(withoutReady);
    board.milestones.push({ number: 7, title: "M1" });
    board.addIssue(
      { number: 42, body: readyBody("OMI-042") },
      { ...READY_FIELDS, "Plan Key": "OMI-042" },
    );
    await expect(adapters(board).board.setStatus(42, "Ready")).rejects.toBeInstanceOf(
      TaskBoardError,
    );
    expect(board.writes).toEqual([]);
  });
});
