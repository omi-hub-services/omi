import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectConfigSchema } from "../../../src/application/contracts/project-config.ts";
import type { InspectedProject } from "../../../src/application/contracts/project-initialization.ts";
import { createTaskCommands } from "../../../src/bootstrap/container.ts";
import { createOnboardingProjectConfigStore } from "../../../src/infrastructure/config/project-config-store.ts";
import { runCli } from "../../../src/interfaces/cli/commands/create-program.ts";
import { FakeGithubBoard } from "../../contract/github/fake-github-board.ts";
import { FRONTMATTER, SPEC_BODY } from "../../unit/application/use-cases/tasks/intake-fakes.ts";

const select = (name: string, values: readonly string[]) => ({
  id: `F_${name.replace(/\W/g, "")}`,
  name,
  dataType: "SINGLE_SELECT",
  options: values.map((value) => ({ id: `opt_${value.replace(/\W/g, "")}`, name: value })),
});
const PROJECT: InspectedProject = {
  id: "PVT_1",
  number: 1,
  title: "delivery",
  owner: { id: "O_1", login: "acme", type: "Organization" },
  fields: [
    select("Status", ["Backlog", "Ready", "In Progress", "Done"]),
    select("Priority", ["P1"]),
    select("Work Type", ["Task", "Epic"]),
    select("Workflow", ["feature"]),
    select("Role", ["Developer"]),
    select("Area", ["tooling"]),
    { id: "F_PlanKey", name: "Plan Key", dataType: "TEXT", options: [] },
  ],
};
const READY_BODY = `## Mục tiêu\nGoal.\n## Phạm vi\nScope.\n## Acceptance criteria\n- [ ] one\n## Implementation map\n- src/application/map.ts\n## Dependencies\nNone.\n<!-- omi-squad:plan-key=OMI-001 -->\n## Framework counterpart\nsrc/domain/tasks/readiness-gate.ts\n`;
const BACKLOG_FIELDS = {
  Status: "Backlog",
  Priority: "P1",
  "Work Type": "Task",
  Workflow: "feature",
  Role: "Developer",
  Area: "tooling",
  "Plan Key": "OMI-001",
};

let dir: string;
let github: FakeGithubBoard;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omi-wiring-"));
  await createOnboardingProjectConfigStore(dir).create(
    projectConfigSchema.parse({
      schema_version: 1,
      repository: { owner: "acme", name: "app" },
      project: { owner: "acme", number: 1 },
      branches: { integration: "develop", release: "main" },
      limits: { max_parallel_workers: 2, step_timeout_seconds: 600, max_rework_cycles: 2 },
      effort_policy: { low: "low", medium: "medium", high: "high" },
      policies: { mandatory_approvals: ["release", "deploy"] },
    }),
  );
  github = new FakeGithubBoard(PROJECT);
  github.milestones.push({ number: 7, title: "M1" });
  github.addIssue(
    {
      number: 1,
      id: 101,
      title: "[EP-001] Epic",
      body: "<!-- omi-squad:plan-key=EP-001 -->",
    },
    { "Work Type": "Epic", "Plan Key": "EP-001" },
  );
  github.addIssue(
    {
      number: 2,
      id: 102,
      title: "[OMI-000] Blocker",
      body: "<!-- omi-squad:plan-key=OMI-000 -->",
      state: "CLOSED",
    },
    { "Plan Key": "OMI-000" },
  );
  github.addIssue(
    { number: 3, id: 103, title: "[OMI-001] Task", body: READY_BODY, milestone: "M1" },
    BACKLOG_FIELDS,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The real CLI and the real task-commands factory; only GitHub's transport is fake. */
async function run(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(argv, {
    sendCommand: () => Promise.reject(new Error("no runtime needed")),
    defaultSocketPath: "/nowhere.sock",
    timeoutMs: 100,
    version: "0.0.0",
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    tasks: createTaskCommands(github),
  });
  return { code, out, err };
}

describe("task commands wired through the CLI and the container", () => {
  it("promote <n> --project moves the Issue to Ready", async () => {
    const result = await run("promote", "3", "--project", dir);
    expect(result.err).not.toContain("unrecognized_keys");
    expect(result).toMatchObject({ code: 0 });
    expect(github.items.find((i) => i.issueNumber === 3)?.values["Status"]).toBe("Ready");
  });

  it("promote --project --dry-run reports the candidate and writes nothing", async () => {
    const result = await run("promote", "--project", dir, "--dry-run");
    expect(result.err).not.toContain("unrecognized_keys");
    expect(result.code).toBe(0);
    expect(github.writes).toEqual([]);
  });

  it("set-status <n> Ready --project moves the Issue to Ready", async () => {
    const result = await run("set-status", "3", "Ready", "--project", dir);
    expect(result.err).not.toContain("unrecognized_keys");
    expect(result.code).toBe(0);
    expect(github.items.find((i) => i.issueNumber === 3)?.values["Status"]).toBe("Ready");
  });

  it("new-issue --project previews through the same factory", async () => {
    const file = join(dir, "spec.md");
    await writeFile(
      file,
      `---\n${Object.entries(FRONTMATTER)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join("\n")}\n---\n${SPEC_BODY}\n`,
    );
    const result = await run("new-issue", "--project", dir, "--file", file, "--prefix", "OMI");
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(github.writes).toEqual([]);
  });
});
