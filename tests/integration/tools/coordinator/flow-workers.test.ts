import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitWorkerCommand,
  dispatchCommand,
  reviewCommentCommand,
  workerReportCommand,
} from "../../../../tools/coordinator/flow-workers.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";
import type { WslTarget } from "../../../../tools/coordinator/coordinator-settings.ts";

const target: WslTarget = {
  viaWslExe: true,
  distro: "Ubuntu-24.04",
  repoDir: "/home/u/omi-wt/omi-077",
};
const payload = (c: Command) => c.args.at(-1) ?? "";

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

function fake(
  handler: (c: Command) => { code?: number; stdout?: string; stderr?: string } | undefined,
) {
  const seen: Command[] = [];
  const run: Runner = (c) => {
    seen.push(c);
    const r = handler(c);
    return Promise.resolve({
      code: r?.code ?? 0,
      stdout: r?.stdout ?? "",
      stderr: r?.stderr ?? "",
    });
  };
  return { run, seen, ctx: { run, target } };
}

const dispatchInput = {
  planKey: "OMI-077",
  role: "Developer",
  workflow: "feature",
  complexity: "medium",
  kind: "claude",
  profile: "ggtintran",
  resume: null,
  prompt: "## Task\nBuild it.\n",
  dryRun: false,
} as const;

const skillRunner = (c: Command) => {
  const m = /cat templates\/project\/\.omi-squad\/skills\/([a-z-]+)\/SKILL\.md/.exec(payload(c));
  return m ? { stdout: `BODY(${m[1] ?? ""})\n` } : undefined;
};

describe("dispatchCommand", () => {
  it("writes the prompt with the Developer skills, then launches Claude in the worktree, once", async () => {
    const f = fake(
      (c) =>
        skillRunner(c) ?? (payload(c).includes("claude -p") ? { stdout: "exit=0\n" } : undefined),
    );
    expect(await dispatchCommand(f.ctx, dispatchInput)).toBe(0);

    const write = f.seen.find((c) => payload(c).includes("cat > $HOME/omi-runs/omi-077-prompt.md"));
    expect(write?.input).toBe(
      "## Task\nBuild it.\n" +
        "\n\n## Skill: test-driven-development (follow it; report it under Skills applied)\n\nBODY(test-driven-development)\n" +
        "\n\n## Skill: minimal-change (follow it; report it under Skills applied)\n\nBODY(minimal-change)\n" +
        "\n\n## Skill: verification-before-completion (follow it; report it under Skills applied)\n\nBODY(verification-before-completion)\n",
    );
    const launches = f.seen.filter((c) => payload(c).includes("claude -p"));
    expect(launches).toHaveLength(1);
    expect(payload(launches[0] as Command)).toContain("--model claude-sonnet-5-5 --effort medium");
    expect(launches[0]?.args).toContain("/home/u/omi-wt/omi-077"); // --cd the worktree (OMI_WSL_REPO_DIR)
    expect(launches[0]?.timeoutMs).toBeGreaterThan(3_600_000); // foreground for hours
    // write happens before launch, and skills are read from the worker's checkout
    expect(f.seen.indexOf(write as Command)).toBeLessThan(f.seen.indexOf(launches[0] as Command));
    expect(out.join("\n")).toContain("exit=0");
  });

  it("uses the effort policy: a high-complexity task gets Opus and high effort", async () => {
    const f = fake((c) => skillRunner(c) ?? { stdout: "exit=0\n" });
    await dispatchCommand(f.ctx, { ...dispatchInput, complexity: "high" });
    const launch = f.seen.find((c) => payload(c).includes("claude -p"));
    expect(payload(launch as Command)).toContain("--model claude-opus-5-5 --effort high");
  });

  it("leaves test-driven-development out of the docs workflow prompt", async () => {
    const f = fake((c) => skillRunner(c) ?? { stdout: "exit=0\n" });
    await dispatchCommand(f.ctx, { ...dispatchInput, workflow: "docs" });
    const write = f.seen.find((c) => payload(c).includes("cat > "));
    expect(write?.input).not.toContain("test-driven-development");
    expect(write?.input).toContain("## Skill: minimal-change");
  });

  it("launches Codex with codex exec --json and the Codex policy model", async () => {
    const f = fake((c) => skillRunner(c) ?? { stdout: "exit=0\n" });
    await dispatchCommand(f.ctx, { ...dispatchInput, kind: "codex" });
    const launch = f.seen.find((c) => payload(c).includes("codex exec"));
    expect(payload(launch as Command)).toContain(
      "codex exec --json -s workspace-write -m gpt-6.1-sol",
    );
    expect(f.seen.some((c) => payload(c).includes("claude -p"))).toBe(false);
  });

  it("resumes with the follow-up prompt only: no skills appended again", async () => {
    const f = fake((c) => skillRunner(c) ?? { stdout: "exit=0\n" });
    await dispatchCommand(f.ctx, {
      ...dispatchInput,
      resume: "sess-123",
      prompt: "fix the findings\n",
    });
    const write = f.seen.find((c) => payload(c).includes("cat > "));
    expect(write?.input).toBe("fix the findings\n");
    expect(f.seen.some((c) => /cat templates/.test(payload(c)))).toBe(false);
    expect(payload(f.seen.find((c) => payload(c).includes("claude -p")) as Command)).toContain(
      "--resume sess-123",
    );
  });

  it("with --dry-run prints the commands and changes nothing", async () => {
    const f = fake((c) => skillRunner(c));
    expect(await dispatchCommand(f.ctx, { ...dispatchInput, dryRun: true })).toBe(0);
    expect(f.seen.some((c) => payload(c).includes("cat > "))).toBe(false);
    expect(f.seen.some((c) => payload(c).includes("claude -p"))).toBe(false);
    const text = out.join("\n");
    expect(text).toContain("would run:");
    expect(text).toContain("claude -p --disable-slash-commands");
    expect(text).toContain("omi-077-prompt.md");
  });

  it("returns 1 when the worker process exits non-zero", async () => {
    const f = fake((c) => skillRunner(c) ?? { stdout: "exit=3\n" });
    expect(await dispatchCommand(f.ctx, dispatchInput)).toBe(1);
  });

  it.each([
    [{ profile: "nobody" }, /profile/],
    [{ kind: "claude+codex-live" }, /kind/],
    [{ planKey: null }, /Plan Key/],
    [{ prompt: "  \n" }, /prompt/],
  ] as const)("refuses %j before touching WSL", async (patch, reason) => {
    const f = fake(() => undefined);
    expect(await dispatchCommand(f.ctx, { ...dispatchInput, ...patch })).toBe(1);
    expect(err.join("\n")).toMatch(/refused/);
    expect(err.join("\n")).toMatch(reason);
    expect(f.seen).toHaveLength(0);
  });
});

describe("workerReportCommand", () => {
  const claudeLog = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "S1" }),
    JSON.stringify({
      type: "result",
      session_id: "S1",
      num_turns: 12,
      result: "FINAL REPORT",
      permission_denials: [{ tool_name: "Bash", tool_input: { command: "git push" } }],
    }),
  ].join("\n");

  it("prints the Claude report, turns, denials and session id from the newest log", async () => {
    const f = fake((c) => {
      if (payload(c).includes("ls -t"))
        return { stdout: "/home/u/omi-runs/omi-077-ggtintran-20261112-1.jsonl\n" };
      if (payload(c).startsWith("cat ")) return { stdout: claudeLog };
      return undefined;
    });
    expect(await workerReportCommand(f.ctx, { planKey: "OMI-077", dryRun: false })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("FINAL REPORT");
    expect(text).toContain("turns: 12");
    expect(text).toContain("Bash: git push");
    expect(text).toContain("session id: S1");
    expect(f.seen.some((c) => payload(c).includes("-last.md"))).toBe(false);
  });

  it("reads -last.md and the thread id for a Codex log", async () => {
    const f = fake((c) => {
      if (payload(c).includes("ls -t"))
        return { stdout: "/home/u/omi-runs/omi-077-codex-ggtintran-20261112-1.jsonl\n" };
      if (payload(c).includes("omi-077-codex-last.md")) return { stdout: "CODEX LAST" };
      if (payload(c).startsWith("cat "))
        return { stdout: '{"type":"thread.started","thread_id":"T9"}\n{"type":"turn.started"}' };
      return undefined;
    });
    expect(await workerReportCommand(f.ctx, { planKey: "OMI-077", dryRun: false })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("CODEX LAST");
    expect(text).toContain("thread id: T9");
  });

  it("refuses when the task has no log", async () => {
    const f = fake(() => ({ stdout: "" }));
    expect(await workerReportCommand(f.ctx, { planKey: "OMI-077", dryRun: false })).toBe(1);
    expect(err.join("\n")).toMatch(/refused: no worker log/);
  });

  it("returns 1 and says so when the run has no result event yet", async () => {
    const f = fake((c) => {
      if (payload(c).includes("ls -t"))
        return { stdout: "/home/u/omi-runs/omi-077-ggtintran-20261112-1.jsonl\n" };
      return { stdout: JSON.stringify({ type: "system", subtype: "init", session_id: "S1" }) };
    });
    expect(await workerReportCommand(f.ctx, { planKey: "OMI-077", dryRun: false })).toBe(1);
    expect(out.join("\n")).toContain("no final report");
    expect(out.join("\n")).toContain("session id: S1");
  });

  it("with --dry-run only prints the listing it would run", async () => {
    const f = fake(() => undefined);
    expect(await workerReportCommand(f.ctx, { planKey: "OMI-077", dryRun: true })).toBe(0);
    expect(f.seen).toHaveLength(0);
    expect(out.join("\n")).toContain("would run:");
  });
});

describe("commitWorkerCommand", () => {
  const BRANCH = "task/omi-077-script-first";
  const git = (c: Command) => payload(c).replace(/^git /, "");
  const repo = (over: { current?: string; staged?: string } = {}) =>
    fake((c) => {
      const g = git(c);
      if (g.startsWith("rev-parse --abbrev-ref")) return { stdout: `${over.current ?? BRANCH}\n` };
      if (g.startsWith("diff --cached --name-only"))
        return { stdout: over.staged ?? "src/a.ts\ndocs/b.md\n" };
      if (g.startsWith("rev-parse HEAD"))
        return { stdout: "abcdef1234567890abcdef1234567890abcdef12\n" };
      return undefined;
    });
  const input = { branch: BRANCH, message: "feat: x\n\nCo-Authored-By: T <t@x>\n", dryRun: false };

  it("stages only the allowed paths, commits with the message on stdin and prints the SHA", async () => {
    const f = repo();
    expect(await commitWorkerCommand(f.ctx, input)).toBe(0);
    const add = f.seen.find((c) => git(c).startsWith("add"));
    expect(git(add as Command)).toBe("add -A -- src tests docs templates schemas");
    const commit = f.seen.find((c) => /\bcommit -F -$/.test(git(c)));
    expect(git(commit as Command)).toBe("-c core.hooksPath=/dev/null commit -F -");
    expect(commit?.input).toBe(input.message);
    expect(out.join("\n")).toContain("abcdef1234567890abcdef1234567890abcdef12");
    expect(f.seen.some((c) => /\.tmp|\.claude/.test(payload(c)))).toBe(false);
  });

  it("refuses the wrong branch before staging anything", async () => {
    const f = repo({ current: "develop" });
    expect(await commitWorkerCommand(f.ctx, input)).toBe(1);
    expect(err.join("\n")).toMatch(/refused/);
    expect(f.seen.some((c) => git(c).startsWith("add"))).toBe(false);
  });

  it("refuses when nothing is staged and does not commit", async () => {
    const f = repo({ staged: "" });
    expect(await commitWorkerCommand(f.ctx, input)).toBe(1);
    expect(err.join("\n")).toMatch(/nothing/);
    expect(f.seen.some((c) => /\bcommit -F -$/.test(git(c)))).toBe(false);
  });

  it("refuses when .claude/ is already in the index", async () => {
    const f = repo({ staged: "src/a.ts\n.claude/settings.json\n" });
    expect(await commitWorkerCommand(f.ctx, input)).toBe(1);
    expect(err.join("\n")).toContain(".claude/settings.json");
    expect(f.seen.some((c) => /\bcommit -F -$/.test(git(c)))).toBe(false);
  });

  it("refuses an empty message", async () => {
    const f = repo();
    expect(await commitWorkerCommand(f.ctx, { ...input, message: " \n" })).toBe(1);
    expect(f.seen).toHaveLength(0);
  });

  it("with --dry-run checks the branch and prints add and commit without running them", async () => {
    const f = repo();
    expect(await commitWorkerCommand(f.ctx, { ...input, dryRun: true })).toBe(0);
    expect(f.seen.some((c) => git(c).startsWith("add") || /\bcommit -F -$/.test(git(c)))).toBe(
      false,
    );
    expect(out.join("\n")).toContain("would run:");
  });

  it("returns 1 and prints stderr when the commit fails", async () => {
    const f = fake((c) => {
      const g = git(c);
      if (g.startsWith("rev-parse --abbrev-ref")) return { stdout: `${BRANCH}\n` };
      if (g.startsWith("diff --cached")) return { stdout: "src/a.ts\n" };
      if (/\bcommit -F -$/.test(g)) return { code: 1, stderr: "commit failed" };
      return undefined;
    });
    expect(await commitWorkerCommand(f.ctx, input)).toBe(1);
    expect(err.join("\n")).toContain("commit failed");
  });
});

describe("reviewCommentCommand", () => {
  const HEAD = "9d0fba0123456789012345678901234567890abc";
  const body = "**VERDICT:** PASS · **REVIEWED_HEAD:** `9d0fba0`\n\nAC-1: met — a\nAC-2: met — b\n";
  const issueBody = "## Acceptance criteria\n- [ ] one\n- [ ] two\n\n## Dependencies\nNone.\n";
  const input = { pr: 160, prState: "OPEN", prHead: HEAD, issueBody, body, dryRun: false };
  const gh = (login = "minibox-claude-code") =>
    fake((c) =>
      c.args[0] === "api" && c.args[1] === "user" ? { stdout: `${login}\n` } : undefined,
    );

  it("posts a valid review through gh pr comment with the body on stdin", async () => {
    const f = gh();
    expect(await reviewCommentCommand(f.ctx, input)).toBe(0);
    const post = f.seen.find((c) => c.args[0] === "pr" && c.args[1] === "comment");
    expect(post).toMatchObject({ file: "gh", input: body });
    expect(post?.args).toEqual([
      "pr",
      "comment",
      "160",
      "-R",
      "omi-hub-services/omi",
      "--body-file",
      "-",
    ]);
  });

  it("refuses an invalid review with every reason and posts nothing", async () => {
    const f = gh();
    const bad = body.replace("AC-2: met — b", "AC-2: not met — missing");
    expect(await reviewCommentCommand(f.ctx, { ...input, body: bad })).toBe(1);
    expect(err.join("\n")).toMatch(/refused.*PASS.*AC-2/s);
    expect(f.seen.some((c) => c.args[1] === "comment")).toBe(false);
  });

  it("refuses when the AC count of the Issue differs from the lines", async () => {
    const f = gh();
    const three = issueBody.replace("- [ ] two", "- [ ] two\n- [ ] three");
    expect(await reviewCommentCommand(f.ctx, { ...input, issueBody: three })).toBe(1);
    expect(err.join("\n")).toContain("AC-3");
  });

  it("refuses a review for a PR that is not open", async () => {
    const f = gh();
    expect(await reviewCommentCommand(f.ctx, { ...input, prState: "MERGED" })).toBe(1);
    expect(f.seen.some((c) => c.args[1] === "comment")).toBe(false);
  });

  it("refuses to post from an account other than the Coordinator's", async () => {
    const f = gh("someone-else");
    expect(await reviewCommentCommand(f.ctx, input)).toBe(1);
    expect(err.join("\n")).toMatch(/minibox-claude-code/);
    expect(f.seen.some((c) => c.args[1] === "comment")).toBe(false);
  });

  it("with --dry-run validates and prints the post it would make", async () => {
    const f = gh();
    expect(await reviewCommentCommand(f.ctx, { ...input, dryRun: true })).toBe(0);
    expect(f.seen.some((c) => c.args[1] === "comment")).toBe(false);
    expect(out.join("\n")).toContain("would run: gh pr comment 160");
  });
});
