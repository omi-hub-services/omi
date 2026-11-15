import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  COORDINATOR_LOGIN,
  OWNER,
  PROJECT_NUMBER,
  WORKER_PROFILES,
} from "../../../../tools/coordinator/coordinator-settings.ts";
import { dispatchCommand } from "../../../../tools/coordinator/flow-workers.ts";
import { main, pickProfileCommand } from "../../../../tools/coordinator/flow.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

let dir: string;
let output: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omi-architect-"));
  output = [];
  vi.spyOn(console, "log").mockImplementation((...s: unknown[]) => void output.push(s.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...s: unknown[]) => void output.push(s.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const HEAD = "a".repeat(40);
const verdict = (v: "PASS" | "FAIL", n: number) =>
  `**VERDICT:** ${v} · **REVIEWED_HEAD:** \`${HEAD.slice(0, 7)}\`\nAC-1: not met — defect class ${String(n)}`;
const comment = (author: string, body: string) => ({ author: { login: author }, body });

function fake(
  prComments: ReturnType<typeof comment>[],
  issueComments: { body: string; author: string }[] = [],
) {
  cpSync(resolve("templates"), join(dir, "templates"), { recursive: true });
  const run: Runner = (c: Command) => {
    if (c.file === "gh" && c.args[0] === "pr") {
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify([{ number: 9, comments: prComments }]),
      });
    }
    if (c.file === "gh") {
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: {
                title: "Rework task",
                body: "## Acceptance criteria\n- [ ] first\n- [ ] second\n## Implementation map\n- tools/coordinator/flow.ts\n",
                url: "https://example.test/issues/7",
                projectItems: {
                  nodes: [
                    {
                      project: { number: PROJECT_NUMBER, owner: { login: OWNER } },
                      workflow: { name: "feature" },
                      planKey: { text: "OMI-007" },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                comments: {
                  nodes: issueComments.map((m) => ({
                    body: m.body,
                    author: { login: m.author },
                    url: "https://example.test/c",
                  })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      });
    }
    return Promise.resolve({ code: 0, stderr: "", stdout: "task/omi-007-x\n" });
  };
  return {
    run,
    target: { viaWslExe: false, distro: "Ubuntu", repoDir: process.cwd() },
    hostCwd: process.cwd(),
    isWindows: false,
    toolRoot: dir,
  };
}

const files = () => {
  const write = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  return {
    previous: write("prev.md", "PREVIOUS VERDICT TEXT"),
    delta: write("delta.md", "DELTA TEXT"),
    notes: write("notes.md", "NOTES TEXT"),
    out: join(dir, "out.md"),
  };
};
const args = (f: ReturnType<typeof files>, extra: string[] = []) => [
  "prompt",
  "7",
  "--architect",
  "--round",
  "3",
  "--previous-verdict",
  f.previous,
  "--delta",
  f.delta,
  "--notes",
  f.notes,
  "--out",
  f.out,
  ...extra,
];
const twoFails = [
  comment(COORDINATOR_LOGIN, verdict("FAIL", 1)),
  comment(COORDINATOR_LOGIN, verdict("FAIL", 2)),
];

it("renders the Architect packet with role skills, rules, FAIL history, delta and contract", async () => {
  const f = files();
  expect(await main(args(f), fake(twoFails))).toBe(0);
  const text = (await import("node:fs")).readFileSync(f.out, "utf8");
  expect(text).toContain('"step":"architect"');
  expect(text).toContain("role architect");
  for (const id of ["requirements-analysis", "minimal-change"])
    expect(text).toContain(`## Skill: ${id}`);
  for (const id of ["architecture-boundaries", "project-baseline", "approval-gates"])
    expect(text).toContain(`## Rule: ${id}`);
  expect(text).toContain("## Quality round history");
  expect(text).toContain("defect class 1");
  expect(text).toContain("defect class 2");
  expect(text).toContain("DELTA TEXT");
  expect(text).toContain("PREVIOUS VERDICT TEXT");
  expect(text).toContain("simplest design");
  expect(text).toContain("read-only");
  expect(text).toContain("step-result-v1");
  expect(text).toContain("4000");
  expect(text).toContain("file:line");
  expect(text).toContain("Issue #7");
});

it("refuses --architect with fewer than two Coordinator FAIL verdicts since the last PASS", async () => {
  const f = files();
  const comments = [
    comment(COORDINATOR_LOGIN, verdict("FAIL", 1)),
    comment(COORDINATOR_LOGIN, verdict("PASS", 2)),
    comment(COORDINATOR_LOGIN, verdict("FAIL", 3)),
  ];
  expect(await main(args(f), fake(comments))).toBe(1);
  expect(output.join("\n")).toContain("at least two");
});

it("ignores a FAIL verdict from a non-Coordinator account", async () => {
  const f = files();
  const comments = [
    comment(COORDINATOR_LOGIN, verdict("FAIL", 1)),
    comment("someone-else", verdict("FAIL", 2)),
  ];
  expect(await main(args(f), fake(comments))).toBe(1);
  expect(output.join("\n")).toContain("at least two");
});

it("refuses a second Architect packet for the same round", async () => {
  const f = files();
  const marker = comment(COORDINATOR_LOGIN, "**ARCHITECT:** two FAILs");
  expect(await main(args(f), fake([...twoFails, marker]))).toBe(1);
  expect(output.join("\n")).toContain("already");
});

it("refuses --architect combined with --findings or another step", async () => {
  const f = files();
  expect(await main(args(f, ["--step", "implement"]), fake(twoFails))).toBe(1);
  expect(await main(args(f, ["--findings", f.notes]), fake(twoFails))).toBe(1);
});

it("a work-step packet carries the Architect decision verbatim in its own section", async () => {
  const f = files();
  const decision = join(dir, "decision.md");
  writeFileSync(decision, "DELETE the retry loop.\nKeep flow.ts:12 only.");
  const argv = [
    "prompt",
    "7",
    "--step",
    "implement",
    "--findings",
    f.notes,
    "--architect-decision",
    decision,
    "--out",
    f.out,
  ];
  expect(await main(argv, fake(twoFails))).toBe(0);
  const text = (await import("node:fs")).readFileSync(f.out, "utf8");
  expect(text).toContain(
    "## Architect decision (verbatim)\nDELETE the retry loop.\nKeep flow.ts:12 only.",
  );
});

const claude = WORKER_PROFILES.find((p) => p.tool === "claude");
const PACKET = `<!-- omi-quality {"policy":"task-default","step":"architect","steps":["architect"],"round":3} -->\n# x`;
const dispatchInput = (resume: string | null) => ({
  planKey: "OMI-007",
  role: null,
  workflow: "feature",
  complexity: "low" as const,
  kind: "claude",
  profile: claude?.profile ?? "",
  resume,
  prompt: PACKET,
  dryRun: true,
});
const dispatchCtx = (seen: Command[]) => ({
  run: ((c: Command) => {
    seen.push(c);
    return Promise.resolve({ code: 0, stdout: "exit=0\n", stderr: "" });
  }) as Runner,
  target: { viaWslExe: false, distro: "d", repoDir: "/home/u/omi" },
});

it("dispatch accepts the Architect packet at high effort and refuses --resume for it", async () => {
  const seen: Command[] = [];
  expect(await dispatchCommand(dispatchCtx(seen), dispatchInput(null))).toBe(0);
  expect(output.join("\n")).toContain("--effort high");
  output.length = 0;
  expect(await dispatchCommand(dispatchCtx(seen), dispatchInput("sess1"))).toBe(1);
  expect(output.join("\n")).toContain("fresh independent");
});

it("pick-profile --step architect advises high effort even for a low-complexity task", async () => {
  const run: Runner = (c) =>
    Promise.resolve({
      code: 0,
      stderr: "",
      stdout:
        c.file === "gh"
          ? JSON.stringify({
              data: {
                organization: { projectV2: { id: "p", field: { id: "s", options: [] } } },
                repository: {
                  issue: {
                    state: "OPEN",
                    body: "## Acceptance criteria\n- [ ] one\n",
                    comments: { nodes: [] },
                    timelineItems: { nodes: [] },
                    labels: { nodes: [], pageInfo: { hasNextPage: false } },
                    projectItems: {
                      nodes: [
                        {
                          id: "i",
                          project: { id: "p" },
                          complexity: { name: "low" },
                          workflow: { name: "feature" },
                          workType: { name: "Task" },
                          area: { name: "docs" },
                          priority: { name: "P1" },
                        },
                      ],
                    },
                  },
                },
              },
            })
          : JSON.stringify({ kind: "now", now: 1794290000 }),
    });
  const ctx = {
    run,
    target: { viaWslExe: false, distro: "d", repoDir: "/x" },
    hostCwd: process.cwd(),
    isWindows: false,
  };
  expect(await pickProfileCommand(ctx, 7, "claude", true, true, null, "architect", 3)).toBe(0);
  const parsed = JSON.parse(output.at(-1) ?? "{}") as { chosen: { effort: string }[] };
  expect(parsed.chosen[0]?.effort).toBe("high");
});
