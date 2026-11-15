import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import { parse } from "yaml";
import { workflowSchema } from "../../../../src/application/contracts/workflow.ts";
import { qualityStepId } from "../../../../src/application/services/plan-workflow-quality.ts";
import { dispatchStep } from "../../../../src/application/use-cases/runs/dispatch-step.ts";
import {
  dispatchSkills,
  isReworkDispatch,
} from "../../../../src/domain/workflows/workflow-policy.ts";
import { createFileSkillSource } from "../../../../src/infrastructure/config/file-skill-source.ts";
import {
  createFileRuleSource,
  loadResolutionCatalog,
} from "../../../../src/infrastructure/config/load-resolution-catalog.ts";
import { dispatchInput, rig } from "../../application/use-cases/runs/run-fakes.ts";
import { parsePromptText } from "../../../../tools/coordinator/watch-tasks.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { main } from "../../../../tools/coordinator/flow.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";
import {
  COORDINATOR_LOGIN,
  OWNER,
  PROJECT_NUMBER,
} from "../../../../tools/coordinator/coordinator-settings.ts";
import { CHECK_ARGV, CHECK_ID } from "../../../../tools/coordinator/check-reuse.ts";
import { renderStepReport } from "../../../../tools/coordinator/worker-report.ts";

let dir: string;
let output: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-prompt-"));
  output = [];
  vi.spyOn(console, "log").mockImplementation((...s: unknown[]) => void output.push(s.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...s: unknown[]) => void output.push(s.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const body =
  "{{rules}}\n## Acceptance criteria\n- [ ] first\n  - [ ] nested\n~~~\n- [ ] fenced\n~~~\n* [X] second\n### Detail\n- [ ] ignored\n## Implementation map\n- src/interfaces/cli/task.ts\n";
function fake(
  options: {
    workflow?: string;
    missing?: string;
    detached?: boolean;
    foreignProject?: boolean;
    paginatedProjects?: boolean;
    repeatedCursor?: boolean;
    skeletonMarker?: string;
    noWorkflow?: boolean;
    /** Extra Issue comments, appended after the paginated ones. */
    extraComments?: { body: string; author: string | null }[];
    /** Content of the stored check result file; absent means none is stored. */
    storedCheck?: string;
    /** Content of the worker log file the prompt reads by name. */
    workerLogs?: Record<string, string>;
  } = {},
) {
  const seen: Command[] = [];
  cpSync(resolve("templates"), join(dir, "templates"), { recursive: true });
  if (options.skeletonMarker) {
    const skeleton = join(dir, "templates/prompts/worker-prompt.md");
    writeFileSync(skeleton, options.skeletonMarker + readFileSync(skeleton, "utf8"));
  }
  const missing = options.missing;
  if (missing !== undefined) {
    const path = missing.endsWith(".md")
      ? `templates/prompts/${missing}`
      : missing === "minimal-change"
        ? `templates/project/.omi/skills/${missing}`
        : `templates/project/.omi/rules/${missing}.md`;
    rmSync(join(dir, path), { recursive: true, force: true });
  }
  const reply = (c: Command) => {
    seen.push(c);
    if (c.file === "gh") {
      const request = JSON.parse(c.input ?? "{}") as {
        variables: { after: string | null; itemsAfter: string | null };
      };
      const second = request.variables.after !== null;
      const nextProjectPage = request.variables.itemsAfter !== null;
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: {
                title: "Prompt task",
                body,
                url: "https://example.test/issues/185",
                projectItems: {
                  nodes: [
                    {
                      project: {
                        number:
                          options.paginatedProjects && !nextProjectPage
                            ? PROJECT_NUMBER + 1
                            : PROJECT_NUMBER,
                        owner: { login: OWNER },
                      },
                      workflow: options.noWorkflow ? null : { name: options.workflow ?? "feature" },
                      planKey: { text: "OMI-090" },
                    },
                    ...(options.foreignProject
                      ? [
                          {
                            project: { number: PROJECT_NUMBER, owner: { login: "another-org" } },
                            workflow: { name: "docs" },
                            planKey: { text: "OMI-999" },
                          },
                        ]
                      : []),
                  ],
                  pageInfo: {
                    hasNextPage: Boolean(options.paginatedProjects && !nextProjectPage),
                    endCursor: options.paginatedProjects && !nextProjectPage ? "items2" : null,
                  },
                },
                comments: {
                  nodes: second
                    ? [
                        {
                          body: "Scope note (PO): {{identity}}",
                          author: { login: "po" },
                          url: "https://example.test/comment/101",
                        },
                        ...(options.extraComments ?? []).map((c, i) => ({
                          body: c.body,
                          author: c.author === null ? null : { login: c.author },
                          url: `https://example.test/comment/extra-${String(i)}`,
                        })),
                      ]
                    : Array.from({ length: 100 }, (_, i) => ({
                        body: `comment ${String(i)}`,
                        author: null,
                        url: `https://example.test/comment/${String(i)}`,
                      })),
                  pageInfo: {
                    hasNextPage: !second || Boolean(options.repeatedCursor),
                    endCursor: second && !options.repeatedCursor ? null : "page2",
                  },
                },
              },
            },
          },
        }),
      };
    }
    const payload = c.args.at(-1) ?? "";
    if (payload.startsWith("git "))
      return {
        code: 0,
        stderr: "",
        stdout: options.detached ? "HEAD\n" : "task/omi-090-prompt-steps\n",
      };
    if (payload.includes("omi-runs/omi-")) {
      const hit = Object.entries(options.workerLogs ?? {}).find(([name]) => payload.includes(name));
      return hit === undefined
        ? { code: 1, stderr: "", stdout: "" }
        : { code: 0, stderr: "", stdout: hit[1] };
    }
    if (payload.includes("omi-runs/checks/"))
      return options.storedCheck === undefined
        ? { code: 1, stderr: "", stdout: "" }
        : { code: 0, stderr: "", stdout: options.storedCheck };
    const path = payload.replace(/^cat -- /, "");
    if (path.includes(options.missing ?? "NONEXISTENT"))
      return { code: 1, stderr: "missing content", stdout: "" };
    return {
      code: 0,
      stderr: "",
      stdout: `${path.endsWith("worker-prompt.md") ? (options.skeletonMarker ?? "") : ""}${readFileSync(resolve(path), "utf8")}`,
    };
  };
  const run: Runner = (c) => Promise.resolve(reply(c));
  return {
    seen,
    ctx: {
      run,
      target: { viaWslExe: false, distro: "Ubuntu", repoDir: process.cwd() },
      hostCwd: process.cwd(),
      isWindows: false,
      toolRoot: dir,
    },
  };
}

it("uses only the configured owner's Project and supplies the concrete Plan Key", async () => {
  expect(
    await main(["prompt", "185", "--step", "implement"], fake({ foreignProject: true }).ctx),
  ).toBe(0);
  const text = output.join("\n");
  expect(text).toContain("ending (OMI-090)");
  expect(text).not.toContain("OMI-999");
});

it("states the checks/skillsApplied entry shape in the report contract (OMI-146)", async () => {
  expect(await main(["prompt", "185", "--step", "implement"], fake().ctx)).toBe(0);
  const text = output.join("\n");
  expect(text).toContain("`artifacts`, `checks` and `skillsApplied` stay empty arrays");
  expect(text).toContain("quote checks and skills in `summary`");
  expect(text).toContain('any entry must be an object `{"id","evidenceRef"}`');
});

it("reads the Workflow from later Project-item pages without duplicating comments", async () => {
  const f = fake({ paginatedProjects: true });
  expect(await main(["prompt", "185", "--step", "implement"], f.ctx)).toBe(0);
  expect(output.join("\n").match(/BEGIN COMMENT/g)).toHaveLength(101);
  expect(f.seen.filter((c) => c.file === "gh")).toHaveLength(2);
});

it.each([
  ["docs", "write"],
  ["docs", "accept"],
  ["bugfix", "fix"],
])("accepts actual %s/%s IDs", async (workflow, step) => {
  expect(await main(["prompt", "185", "--step", step], fake({ workflow }).ctx)).toBe(0);
  expect(output.join("\n")).toContain(`Workflow ${workflow} · step ${step}`);
});

it("tells the bugfix fix worker to report regressionTest, and no other step", async () => {
  expect(await main(["prompt", "185", "--step", "fix"], fake({ workflow: "bugfix" }).ctx)).toBe(0);
  expect(output.join("\n")).toContain('"regressionTest": {"file"');
  output.length = 0;
  expect(await main(["prompt", "185", "--step", "review"], fake({ workflow: "bugfix" }).ctx)).toBe(
    0,
  );
  expect(output.join("\n")).not.toContain("regressionTest");
});

it("reads pinned tool assets independently of the worker checkout", async () => {
  const f = fake({ skeletonMarker: "PACKAGED MARKER\n" });
  expect(
    await main(
      ["prompt", "185", "--step", "implement", "--worktree", dir, "--branch", "explicit"],
      f.ctx,
    ),
  ).toBe(0);
  expect(output.join("\n")).toContain("PACKAGED MARKER");
  expect(f.seen.some((c) => c.args.at(-1)?.startsWith("cat -- "))).toBe(false);
  expect(f.seen.filter((c) => c.file !== "gh").every((c) => c.cwd === dir)).toBe(true);
});

it.each(["analyze", "implement", "review"])(
  "renders the exact %s step packet with complete paginated task data",
  async (step) => {
    const f = fake();
    expect(await main(["prompt", "185", "--step", step], f.ctx)).toBe(0);
    const text = output.join("\n");
    expect(text).toContain(body);
    expect(text).toContain("Scope note (PO): {{identity}}");
    expect(text).toContain("https://example.test/comment/101");
    expect(text).toContain("AC-1: first");
    expect(text).toContain("AC-2: second");
    expect(text).not.toContain("AC-3:");
    expect(text).toContain("task/omi-090-prompt-steps");
    expect(text).toContain("Skills applied");
    expect(text).toContain("Rules applied");
    const { parse } = await import("yaml");
    const workflow = parse(readFileSync("templates/project/workflows/feature.yaml", "utf8")) as {
      steps: { id: string; role: string; skills: string[]; rules: string[] }[];
    };
    const selected = workflow.steps.find((s) => s.id === step);
    expect(selected).toBeDefined();
    expect(text).toContain(`role ${selected?.role ?? ""}`);
    for (const skill of selected?.skills ?? [])
      expect(text).toContain(
        readFileSync(`templates/project/.omi/skills/${skill}/SKILL.md`, "utf8"),
      );
    for (const rule of selected?.rules ?? [])
      expect(text).toContain(readFileSync(`templates/project/.omi/rules/${rule}.md`, "utf8"));
    expect((text.match(/## Skill:/g) ?? []).length).toBe(selected?.skills.length);
    expect(text).not.toMatch(/^## Rule:.*\(mandatory\)/m);
    expect(f.seen.filter((c) => c.file === "gh")).toHaveLength(2);
  },
);

it.each([{ options: [] }, { options: ["--dry-run"] }])(
  "renders a release review packet with options $options",
  async ({ options }) => {
    const f = fake({ workflow: "release" });
    expect(await main(["prompt", "311", "--step", "review", ...options], f.ctx)).toBe(0);
    const text = output.join("\n");
    expect(text).toContain("Workflow release · step review · role reviewer");
    expect(text).toContain("AC-n: deferred — <Coordinator step>");
    expect(text).toContain("every non-deferred AC met");
    expect(text).toContain("close still requires every AC met");
    expect(text).toContain(
      readFileSync("templates/project/.omi/skills/independent-review/SKILL.md", "utf8"),
    );
    for (const rule of ["project-baseline", "approval-gates", "evidence-and-tests"])
      expect(text).toContain(readFileSync(`templates/project/.omi/rules/${rule}.md`, "utf8"));
    expect(text).toContain("## Report contract");
    expect(text).toContain("review-result-v1");
    expect(text).toContain('"stepId":"review"');
  },
);

it("keeps deploy review behind its delivery refusal", async () => {
  const f = fake({ workflow: "deploy" });
  expect(await main(["prompt", "311", "--step", "review"], f.ctx)).toBe(1);
  expect(output.join("\n")).toBe(
    "prompt: refused: Workflow deploy uses the gated deploy-release delivery use case, not worker dispatch",
  );
});

it.each(["analyze", "implement", "verify", "prepare-release", "verify,review", "unknown"])(
  "keeps the gated release refusal for step %s",
  async (step) => {
    const f = fake({ workflow: "release" });
    expect(await main(["prompt", "311", "--step", step, "--dry-run"], f.ctx)).toBe(1);
    expect(output.join("\n")).toBe(
      "prompt: refused: Workflow release uses the gated prepare-release delivery use case, not worker dispatch",
    );
  },
);

it("writes only --out and preserves notes bytes and overrides", async () => {
  const notes = join(dir, "notes.md");
  const out = join(dir, "prompt.md");
  writeFileSync(notes, "notes\r\n{{rules}}\r\n");
  const f = fake();
  expect(
    await main(
      [
        "prompt",
        "185",
        "--step",
        "implement",
        "--notes",
        notes,
        "--out",
        out,
        "--branch",
        "explicit",
        "--worktree",
        process.cwd(),
      ],
      f.ctx,
    ),
  ).toBe(0);
  expect(output).toEqual([]);
  expect(readFileSync(out, "utf8")).toContain("notes\r\n{{rules}}\r\n");
  expect(readFileSync(out, "utf8")).toContain("explicit");
});

it("previews --dry-run --out without writing or launching", async () => {
  const out = join(dir, "prompt.md");
  const f = fake();
  expect(await main(["prompt", "185", "--step", "review", "--out", out, "--dry-run"], f.ctx)).toBe(
    0,
  );
  expect(existsSync(out)).toBe(false);
  expect(output.join("\n")).toContain("Prompt task");
  expect(
    f.seen.every(
      (c) =>
        c.file === "gh" ||
        (c.args.at(-1) ?? "").startsWith("cat -- ") ||
        (c.args.at(-1) ?? "").startsWith("git "),
    ),
  ).toBe(true);
});

it("renders findings only for native resume", async () => {
  const findings = join(dir, "findings.md");
  writeFileSync(findings, "fix this\r\n{{task_context}}\n");
  const f = fake();
  expect(await main(["prompt", "185", "--step", "implement", "--findings", findings], f.ctx)).toBe(
    0,
  );
  const text = output.join("\n");
  expect(text).toContain("fix this\r\n{{task_context}}\n");
  expect(text).toContain("native resume");
  expect(text).toContain("Rules applied");
  expect(text).not.toContain(body);
  expect(text).toContain("## Skill: minimal-change");
  expect(text).toContain("## Rule: project-baseline");
  const review = text.indexOf("## Skill: receiving-code-review");
  expect(review).toBeGreaterThan(-1);
  expect(review).toBeLessThan(text.indexOf("fix this"));
});

it.each([
  { args: [], options: {}, reason: /--step/ },
  { args: ["--step", "accept"], options: {}, reason: /step/ },
  { args: ["--step", "implement"], options: { workflow: "../escape" }, reason: /template/ },
  { args: ["--step", "implement"], options: { missing: "minimal-change" }, reason: /missing/ },
  { args: ["--step", "implement"], options: { missing: "approval-gates" }, reason: /missing/ },
  { args: ["--step", "implement"], options: { missing: "worker-prompt.md" }, reason: /missing/ },
  { args: ["--step", "implement"], options: { noWorkflow: true }, reason: /no Workflow/ },
  { args: ["--step", "implement"], options: { workflow: "missing-workflow" }, reason: /template/ },
  {
    args: ["--step", "implement"],
    options: { repeatedCursor: true },
    reason: /pagination did not advance/,
  },
  {
    args: ["--step", "implement", "--findings", "/missing-findings"],
    options: {},
    reason: /ENOENT/,
  },
  { args: ["--step", "implement"], options: { detached: true }, reason: /branch/ },
  { args: ["--step", "implement", "--notes", "/missing-notes"], options: {}, reason: /ENOENT/ },
  {
    args: ["--step", "implement", "--notes", "a", "--findings", "b"],
    options: {},
    reason: /together/,
  },
])("refuses invalid packet input: $reason", async ({ args, options, reason }) => {
  expect(await main(["prompt", "185", ...args], fake(options).ctx)).toBe(1);
  expect(output.join("\n")).toMatch(reason);
});

it("renders the merged review packet with verbatim verification and review skills", async () => {
  expect(await main(["prompt", "185", "--step", "review"], fake().ctx)).toBe(0);
  const text = output.join("\n");
  expect(text).toContain("step review");
  expect(text).toContain("role reviewer");
  expect(text).toContain(
    readFileSync("templates/project/.omi/skills/verification-before-completion/SKILL.md", "utf8"),
  );
  expect(text).toContain(
    readFileSync("templates/project/.omi/skills/independent-review/SKILL.md", "utf8"),
  );
  expect(text).toContain("Judge the supplied script-run check evidence; do not rerun tests.");
  expect(text).toContain("omi-quality");
});
it("passes fixed revision check logs and previous verdict into delta QA/review", async () => {
  const log = join(dir, "check.md");
  const previous = join(dir, "previous.md");
  const delta = join(dir, "delta.md");
  writeFileSync(log, "script check passed");
  writeFileSync(previous, "FAIL at old SHA");
  writeFileSync(delta, "diff since old SHA");
  expect(
    await main(
      [
        "prompt",
        "185",
        "--step",
        "review",
        "--round",
        "2",
        "--head",
        "a".repeat(40),
        "--check-log",
        log,
        "--previous-verdict",
        previous,
        "--delta",
        delta,
      ],
      fake().ctx,
    ),
  ).toBe(0);
  const text = output.join("\n");
  for (const evidence of [
    "script check passed",
    "FAIL at old SHA",
    "diff since old SHA",
    "a".repeat(40),
    "Judge only the delta",
  ])
    expect(text).toContain(evidence);
});
it("renders one review packet for a risky change", async () => {
  expect(await main(["prompt", "185", "--step", "review", "--risk", "gates"], fake().ctx)).toBe(0);
  expect(output.join("\n")).toContain("step review");
  expect(output.join("\n")).toContain("Review focus: gates");
});
it("adds the security-review skill and the Security: requirement only with the security risk", async () => {
  const skill = readFileSync("templates/project/.omi/skills/security-review/SKILL.md", "utf8");
  expect(await main(["prompt", "185", "--step", "review", "--risk", "security"], fake().ctx)).toBe(
    0,
  );
  const risky = output.join("\n");
  expect(risky).toContain("Review focus: security");
  expect(risky).toContain(skill);
  expect(risky).toContain("starts with the line `Security:`");
  // The script records the requirement on the packet's second line, for dispatch metadata.
  expect(risky.split("\n")[1]).toBe("<!-- omi-security-review required -->");
  output.length = 0;
  expect(await main(["prompt", "185", "--step", "review", "--risk", "gates"], fake().ctx)).toBe(0);
  const plain = output.join("\n");
  expect(plain).not.toContain(skill);
  expect(plain).not.toContain("starts with the line `Security:`");
  expect(plain).not.toContain("omi-security-review");
});
it("does not add the security-review skill to a non-review step", async () => {
  const skill = readFileSync("templates/project/.omi/skills/security-review/SKILL.md", "utf8");
  expect(
    await main(["prompt", "185", "--step", "implement", "--risk", "security"], fake().ctx),
  ).toBe(0);
  expect(output.join("\n")).not.toContain(skill);
});

it.each([
  ["feature", 0],
  ["unmapped", 1],
] as const)("checks live Project Workflow option %s against templates", async (name, exit) => {
  const f = fake();
  const run: Runner = (c) =>
    Promise.resolve({
      code: 0,
      stderr: "",
      stdout:
        c.file === "gh"
          ? JSON.stringify({ fields: [{ name: "Workflow", options: [{ name }] }], totalCount: 1 })
          : "feature.yaml\ndocs.yaml\n",
    });
  expect(await main(["workflow-options"], { ...f.ctx, run })).toBe(exit);
  expect(output.join("\n")).toContain(exit === 0 ? "Workflow options match" : "missing template");
});

it("runtime dispatch and --findings packet carry the same skills for every work step", async () => {
  const squad = resolve("templates/project/.omi");
  const catalog = loadResolutionCatalog(squad);
  const skills = createFileSkillSource(squad);
  const rules = createFileRuleSource(squad);
  const findings = join(dir, "findings.md");
  writeFileSync(findings, "fix this\n");
  const covered: string[] = [];
  for (const file of readdirSync(resolve("templates/project/workflows"))) {
    const workflow = workflowSchema.parse(
      parse(readFileSync(resolve("templates/project/workflows", file), "utf8")),
    );
    const f = fake({ workflow: workflow.id });
    for (const step of workflow.steps) {
      const quality = qualityStepId(step);
      const roleSkills =
        catalog.roles.find((r) => r.definition.id === step.role)?.definition.skills ?? [];
      const runtime = async (round: number) => {
        const r = rig();
        const result = await dispatchStep(
          { ...r.deps, catalog, skills, rules },
          dispatchInput({
            role: step.role,
            stepSkills: step.skills,
            stepRules: step.rules,
            requiredChecks: [],
            quality: { policy: "task-default", step: quality, steps: [step.id], round },
          }),
        );
        if (!result.ok) throw new Error(`${workflow.id}/${step.id}: ${result.reason}`);
        return new Set(result.attempt.skills.map((s) => s.id));
      };
      if (!isReworkDispatch(quality, 2)) {
        // The role's own skills may include it (reviewer); rework adds nothing for these steps.
        // dispatchInput's scope is broad, which is a security risk: review gains security-review.
        const broad = { security: true, gates: true, data: true };
        const own = new Set([...roleSkills, ...dispatchSkills(quality, step.skills, 1, broad)]);
        expect(await runtime(1)).toEqual(own);
        // Round-2 quality runs need verdict fixtures; the shared rule is checked directly.
        expect(new Set(dispatchSkills(quality, step.skills, 2))).toEqual(new Set(step.skills));
        continue;
      }
      output.length = 0;
      expect(await main(["prompt", "185", "--step", step.id, "--findings", findings], f.ctx)).toBe(
        0,
      );
      const tooling = new Set(parsePromptText(output.join("\n")).skills);
      expect(tooling).toContain("receiving-code-review");
      expect(await runtime(2)).toEqual(new Set([...roleSkills, ...tooling]));
      expect(await runtime(1)).toEqual(new Set([...roleSkills, ...step.skills]));
      covered.push(step.id);
    }
  }
  expect(covered).toEqual(expect.arrayContaining(["implement", "configure-pipeline", "write"]));
});

// ── OMI-168: earlier-step hand-off and stored check results ──────────────────
const HEAD168 = "c".repeat(40);
/** Only the hand-off section: the same reports also appear verbatim as Issue comments. */
const earlier = (text: string): string =>
  text.split("## Earlier steps (task data)")[1]?.split(/\n## /)[0] ?? "";
const stepReport = (
  step: string,
  round: number,
  summary: string,
  findings: string[] = [],
  truncatedLog?: string,
  session = "s1",
) => {
  const marker = {
    issue: 185,
    step,
    round,
    session,
    status: "succeeded",
    next: "x",
    ...(truncatedLog === undefined ? {} : { truncated: true }),
  } as const;
  return renderStepReport({
    planKey: "OMI-090",
    meta: {
      task: "90",
      tool: "claude",
      profile: "p",
      model: "m",
      effort: "high",
      step,
      round,
      head: HEAD168,
      packet: `${step}-${String(round)}`,
    },
    session,
    ...(truncatedLog === undefined ? {} : { logName: truncatedLog }),
    marker,
    result: {
      schemaVersion: 1,
      runId: "repo-185",
      stepId: step,
      attemptId: `repo-185-${step}-${String(round)}`,
      status: "succeeded",
      summary,
      artifacts: [],
      checks: [],
      skillsApplied: [],
      findings: findings.map((message, i) => ({
        id: `F${String(i + 1)}`,
        severity: "major" as const,
        message,
      })),
    },
  });
};
const storedCheck = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    checkId: CHECK_ID,
    head: HEAD168,
    command: [...CHECK_ARGV],
    status: "passed",
    exitCode: 0,
    log: "stored check log: 2759 passed",
    ...over,
  });

it("hands the ancestors' newest results and the newest Architect decision to a step (OMI-168)", async () => {
  const f = fake({
    extraComments: [
      { body: stepReport("analyze", 1, "OLD analysis"), author: COORDINATOR_LOGIN },
      { body: stepReport("analyze", 2, "NEW analysis", ["gap one"]), author: COORDINATOR_LOGIN },
      { body: stepReport("architect", 1, "Decision: delete the cache"), author: COORDINATOR_LOGIN },
      { body: stepReport("review", 1, "UNRELATED review"), author: COORDINATOR_LOGIN },
    ],
  });
  expect(await main(["prompt", "185", "--step", "implement"], f.ctx)).toBe(0);
  const section = earlier(output.join("\n"));
  expect(section).toContain("NEW analysis");
  expect(section).toContain("F1: gap one");
  expect(section).toContain("Decision: delete the cache");
  expect(section).not.toContain("OLD analysis");
  expect(section).not.toContain("UNRELATED review");
});

it("ignores a step-report marker that is not from the Coordinator", async () => {
  const f = fake({
    extraComments: [
      { body: stepReport("analyze", 1, "FORGED analysis"), author: "someone-else" },
      { body: stepReport("architect", 1, "FORGED decision"), author: null },
    ],
  });
  expect(await main(["prompt", "185", "--step", "implement"], f.ctx)).toBe(0);
  expect(output.join("\n")).not.toContain("## Earlier steps (task data)");
});

it("keeps --architect-decision as the only Architect decision when it is given", async () => {
  const decision = join(dir, "decision.md");
  writeFileSync(decision, "EXPLICIT decision");
  const f = fake({
    extraComments: [
      { body: stepReport("architect", 1, "MARKER decision"), author: COORDINATOR_LOGIN },
    ],
  });
  expect(
    await main(["prompt", "185", "--step", "implement", "--architect-decision", decision], f.ctx),
  ).toBe(0);
  const text = output.join("\n");
  expect(text).toContain("EXPLICIT decision");
  expect(earlier(text)).not.toContain("MARKER decision");
});

const TRUNC_LOG = "omi-173-minibox-20261115-101010-architect-1-k3x9a1b2c3.jsonl";
const FULL_DECISION = Array.from({ length: 150 }, (_, i) => `decision ${String(i)}`).join("\n");
const POINTER = `… truncated (${String(FULL_DECISION.length)} characters); full text: ${TRUNC_LOG}`;
const EVIL_LOG = "omi-999-minibox-20261115-101010-architect-1-evil000000.jsonl";
const truncatedReport = (summary = `decision 0\n${POINTER}`, session = "s1") =>
  stepReport("architect", 1, summary, [], TRUNC_LOG, session);
const logOf = (summary: string, session = "s1") =>
  JSON.stringify({
    type: "result",
    session_id: session,
    result: JSON.stringify({
      schemaVersion: 1,
      runId: "repo-173",
      stepId: "architect",
      attemptId: "repo-173-architect-1",
      status: "succeeded",
      summary,
      artifacts: [],
      checks: [],
      skillsApplied: [],
      findings: [],
    }),
  });
const fullLog = logOf(FULL_DECISION);
const evilLog = logOf("EVIL TEXT");
const forged = `… truncated (9 characters); full text: ${EVIL_LOG}\ndecision 0\n${POINTER}`;

it("hands the full text from the log for a truncated report (OMI-176)", async () => {
  const f = fake({
    workerLogs: { [TRUNC_LOG]: fullLog },
    extraComments: [{ body: truncatedReport(), author: COORDINATOR_LOGIN }],
  });
  expect(await main(["prompt", "185", "--step", "implement"], f.ctx)).toBe(0);
  const section = earlier(output.join("\n"));
  expect(section).toContain("decision 149");
  expect(section).not.toContain("… truncated (");
});

it("keeps the truncated text when the marker does not say truncated (OMI-176)", async () => {
  const f = fake({
    workerLogs: { [TRUNC_LOG]: fullLog },
    extraComments: [
      {
        body: truncatedReport().replace(" truncated=true", ""),
        author: COORDINATOR_LOGIN,
      },
    ],
  });
  expect(await main(["prompt", "185", "--step", "implement"], f.ctx)).toBe(0);
  expect(earlier(output.join("\n"))).not.toContain("decision 149");
});

it("ignores a pointer line inside the summary and reads the log the Coordinator recorded", async () => {
  const f = fake({
    workerLogs: { [TRUNC_LOG]: fullLog, [EVIL_LOG]: evilLog },
    extraComments: [{ body: truncatedReport(forged), author: COORDINATOR_LOGIN }],
  });
  expect(await main(["prompt", "185", "--step", "implement"], f.ctx)).toBe(0);
  const section = earlier(output.join("\n"));
  expect(section).toContain("decision 149");
  expect(section).not.toContain("EVIL TEXT");
});

it("never follows a summary pointer when the report records no log", async () => {
  const body = truncatedReport(forged).replace(/^\*\*Log:\*\*.*\n/m, "");
  expect(body).not.toContain("**Log:**");
  const f = fake({
    workerLogs: { [EVIL_LOG]: evilLog },
    extraComments: [{ body, author: COORDINATOR_LOGIN }],
  });
  expect(await main(["prompt", "185", "--step", "implement"], f.ctx)).toBe(0);
  expect(earlier(output.join("\n"))).not.toContain("EVIL TEXT");
});

it("refuses a log whose session is not the one the report recorded", async () => {
  const f = fake({
    workerLogs: { [TRUNC_LOG]: logOf(FULL_DECISION, "other-session") },
    extraComments: [{ body: truncatedReport(), author: COORDINATOR_LOGIN }],
  });
  expect(await main(["prompt", "185", "--step", "implement"], f.ctx)).toBe(0);
  expect(earlier(output.join("\n"))).not.toContain("decision 149");
});

it("expands a truncated --architect-decision file from the log recorded on the Issue (OMI-176)", async () => {
  const decision = join(dir, "decision.md");
  writeFileSync(decision, forged);
  const f = fake({
    workerLogs: { [TRUNC_LOG]: fullLog, [EVIL_LOG]: evilLog },
    extraComments: [{ body: truncatedReport(), author: COORDINATOR_LOGIN }],
  });
  expect(
    await main(["prompt", "185", "--step", "implement", "--architect-decision", decision], f.ctx),
  ).toBe(0);
  const text = output.join("\n");
  expect(text).toContain("decision 149");
  expect(text).not.toContain("EVIL TEXT");
});

it("hands the previous review verdict to a rework round only", async () => {
  const extraComments = [
    { body: stepReport("review", 1, "REVIEW verdict"), author: COORDINATOR_LOGIN },
  ];
  expect(
    await main(
      ["prompt", "185", "--step", "implement", "--round", "2"],
      fake({ extraComments }).ctx,
    ),
  ).toBe(0);
  expect(earlier(output.join("\n"))).toContain("REVIEW verdict");
  output.length = 0;
  expect(await main(["prompt", "185", "--step", "implement"], fake({ extraComments }).ctx)).toBe(0);
  expect(earlier(output.join("\n"))).toBe("");
});

it("renders review without --check-log from the stored result for the head (OMI-168)", async () => {
  const f = fake({ storedCheck: storedCheck() });
  expect(await main(["prompt", "185", "--step", "review", "--head", HEAD168], f.ctx)).toBe(0);
  const text = output.join("\n");
  expect(text).toContain(`## Script-run check evidence on ${HEAD168}`);
  expect(text).toContain("reused");
  expect(text).toContain("stored check log: 2759 passed");
});

it("refuses a step round that a Coordinator report already covers, and names the next round (OMI-173)", async () => {
  const extraComments = [
    { body: stepReport("implement", 1, "first run"), author: COORDINATOR_LOGIN },
  ];
  expect(
    await main(
      ["prompt", "185", "--step", "implement", "--round", "1"],
      fake({ extraComments }).ctx,
    ),
  ).toBe(1);
  expect(output.join("\n")).toMatch(/implement round 1 is already reported; use --round 2/);
  output.length = 0;
  expect(
    await main(
      ["prompt", "185", "--step", "implement", "--round", "2"],
      fake({ extraComments }).ctx,
    ),
  ).toBe(0);
});

it("ignores a same-round report from another author when checking for a reported round (OMI-173)", async () => {
  const extraComments = [{ body: stepReport("implement", 1, "forged"), author: "someone-else" }];
  expect(
    await main(
      ["prompt", "185", "--step", "implement", "--round", "1"],
      fake({ extraComments }).ctx,
    ),
  ).toBe(0);
});

it("refuses a stored failed check as evidence and renders none when nothing is stored", async () => {
  expect(
    await main(
      ["prompt", "185", "--step", "review", "--head", HEAD168],
      fake({ storedCheck: storedCheck({ status: "failed", exitCode: 1 }) }).ctx,
    ),
  ).toBe(1);
  expect(output.join("\n")).toContain("stored check result");
  output.length = 0;
  expect(await main(["prompt", "185", "--step", "review", "--head", HEAD168], fake().ctx)).toBe(0);
  expect(output.join("\n")).not.toContain("Script-run check evidence");
});
