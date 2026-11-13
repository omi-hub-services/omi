import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { main } from "../../../../tools/coordinator/flow.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";
import { OWNER, PROJECT_NUMBER } from "../../../../tools/coordinator/coordinator-settings.ts";

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
        ? `templates/project/.omi-squad/skills/${missing}`
        : `templates/project/.omi-squad/rules/${missing}.md`;
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

it("reads the Workflow from later Project-item pages without duplicating comments", async () => {
  const f = fake({ paginatedProjects: true });
  expect(await main(["prompt", "185", "--step", "implement"], f.ctx)).toBe(0);
  expect(output.join("\n").match(/BEGIN COMMENT/g)).toHaveLength(101);
  expect(f.seen.filter((c) => c.file === "gh")).toHaveLength(2);
});

it.each([
  ["docs", "write"],
  ["docs", "accept"],
  ["bugfix", "reproduce"],
])("accepts actual %s/%s IDs", async (workflow, step) => {
  expect(await main(["prompt", "185", "--step", step], fake({ workflow }).ctx)).toBe(0);
  expect(output.join("\n")).toContain(`Workflow ${workflow} · step ${step}`);
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

it.each(["analyze", "implement", "verify", "review"])(
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
        readFileSync(`templates/project/.omi-squad/skills/${skill}/SKILL.md`, "utf8"),
      );
    for (const rule of selected?.rules ?? [])
      expect(text).toContain(readFileSync(`templates/project/.omi-squad/rules/${rule}.md`, "utf8"));
    expect((text.match(/## Skill:/g) ?? []).length).toBe(selected?.skills.length);
    expect(text).not.toMatch(/^## Rule:.*\(mandatory\)/m);
    expect(f.seen.filter((c) => c.file === "gh")).toHaveLength(2);
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
  expect(text).not.toContain("## Skill:");
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

it("renders a policy-approved combined packet with verbatim contents of both steps", async () => {
  expect(await main(["prompt", "185", "--step", "verify,review"], fake().ctx)).toBe(0);
  const text = output.join("\n");
  expect(text).toContain("verify + review");
  expect(text).toContain("role reviewer");
  expect(text).toContain(
    readFileSync(
      "templates/project/.omi-squad/skills/verification-before-completion/SKILL.md",
      "utf8",
    ),
  );
  expect(text).toContain(
    readFileSync("templates/project/.omi-squad/skills/independent-review/SKILL.md", "utf8"),
  );
  expect(text).toContain("QA judges the supplied script-run check evidence; do not rerun tests.");
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
        "verify,review",
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
it("refuses to combine a risky change", async () => {
  expect(
    await main(["prompt", "185", "--step", "verify,review", "--risk", "gates"], fake().ctx),
  ).toBe(1);
  expect(output.join("\n")).toContain("separate");
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
