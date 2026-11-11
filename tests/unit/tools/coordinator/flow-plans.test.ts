import { describe, expect, it } from "vitest";
import {
  CLOSE_EVIDENCE_MARKER,
  COORDINATOR_LOGIN,
  type WslTarget,
} from "../../../../tools/coordinator/coordinator-settings.ts";
import {
  assertTaskBranch,
  planCheck,
  planCleanup,
  planClose,
  planMerge,
  planOpenPr,
  planPush,
  planSetStatus,
  planStartBranch,
  taskBranchName,
  toCommands,
  type CleanupState,
  type Plan,
  type PullForMerge,
  type ReferencingPull,
  type Step,
  type StatusField,
} from "../../../../tools/coordinator/flow-plans.ts";

const BRANCH = "task/omi-050-coordinator-skills";
const HEAD = "b0ab3b3b1aa20def858c14f954303c6cc63178bc";
const field: StatusField = {
  projectId: "PVT_1",
  fieldId: "FIELD_1",
  options: [
    { id: "opt-ready", name: "Ready" },
    { id: "opt-progress", name: "In Progress" },
    { id: "opt-done", name: "Done" },
  ],
};

function steps(plan: Plan): readonly Step[] {
  if (plan.kind !== "run") throw new Error(`expected run, got ${JSON.stringify(plan)}`);
  return plan.steps;
}
const argvs = (plan: Plan) => steps(plan).map((s) => s.argv.join(" "));

describe("branch names", () => {
  it("derives task/omi-NNN-slug from the Plan Key, not the Issue number", () => {
    expect(taskBranchName("OMI-050", "coordinator-skills")).toBe(BRANCH);
  });

  it("rejects plan keys and slugs that are not safe branch parts", () => {
    expect(() => taskBranchName("EP-01", "x")).toThrow(/OMI-NNN/);
    for (const slug of ["Has-Caps", "two words", "it's", "a;b", "-lead", "x--y", ""]) {
      expect(() => taskBranchName("OMI-050", slug), slug).toThrow(/kebab-case/);
    }
  });

  it("never treats develop, main or crafted refs as task branches", () => {
    for (const b of [
      "develop",
      "main",
      "task/omi-50-x",
      "task/omi-050-x;rm",
      "task/omi-050-../x",
    ]) {
      expect(() => {
        assertTaskBranch(b);
      }, b).toThrow(/not a task branch/);
    }
  });
});

describe("planSetStatus", () => {
  it("is done when the item already has the Status", () => {
    expect(
      planSetStatus(
        61,
        "In Progress",
        field,
        { itemId: "I", status: "In Progress" },
        {
          planKey: "OMI-050",
          body: "## Acceptance criteria\n- [ ] works\n<!-- omi-squad:plan-key=OMI-050 -->",
          priority: "P1",
          workType: "Task",
          workflow: "feature",
          role: "Developer",
          area: "tools",
        },
      ).kind,
    ).toBe("done");
  });

  it("edits the item with the option ID read from the Project", () => {
    expect(argvs(planSetStatus(61, "Done", field, { itemId: "I", status: "Ready" }))).toEqual([
      "gh project item-edit --id I --project-id PVT_1 --field-id FIELD_1 --single-select-option-id opt-done",
    ]);
  });

  it("refuses an unknown Status or an Issue outside the Project", () => {
    expect(planSetStatus(61, "Doing", field, { itemId: "I", status: null }).kind).toBe("refuse");
    expect(planSetStatus(61, "Done", field, null).kind).toBe("refuse");
  });
});

describe("planStartBranch", () => {
  const state = { current: "develop", local: null, dirty: false };

  it("creates the branch from a freshly fetched origin/develop without tracking it", () => {
    const plan = planStartBranch(BRANCH, state);
    expect(argvs(plan)).toEqual([
      "git fetch origin",
      `git switch --no-track -c ${BRANCH} origin/develop`,
    ]);
    expect(steps(plan).every((s) => s.side === "wsl")).toBe(true);
  });

  it("is done when already on the branch, and switches when it exists", () => {
    expect(planStartBranch(BRANCH, { ...state, current: BRANCH }).kind).toBe("done");
    expect(argvs(planStartBranch(BRANCH, { ...state, local: "abc" }))).toEqual([
      `git switch ${BRANCH}`,
    ]);
  });

  it("refuses to carry tracked changes onto a new task branch", () => {
    expect(planStartBranch(BRANCH, { ...state, dirty: true }).kind).toBe("refuse");
  });
});

describe("planPush", () => {
  it("is done when origin already has the local SHA", () => {
    expect(planPush(BRANCH, HEAD, HEAD).kind).toBe("done");
  });

  it("pushes without any force option when origin differs", () => {
    const argv = steps(planPush(BRANCH, HEAD, "1111111")).flatMap((s) => s.argv);
    expect(argv).toEqual(["git", "push", "-u", "origin", BRANCH]);
    expect(argv.some((a) => a.includes("force") || a === "-f" || a.startsWith("+"))).toBe(false);
  });

  it("refuses a branch that does not exist locally", () => {
    expect(planPush(BRANCH, null, null).kind).toBe("refuse");
  });
});

describe("planCheck", () => {
  const ok = { current: BRANCH, head: HEAD, clean: true };

  it("runs npm run check (with Node) only on the exact head with a clean tree", () => {
    const s = steps(planCheck(BRANCH, "b0ab3b3", ok));
    expect(s).toEqual([{ side: "wsl", argv: ["npm", "run", "check"], needsNode: true }]);
  });

  it("refuses another branch, another head or untracked files", () => {
    expect(planCheck(BRANCH, "b0ab3b3", { ...ok, current: "develop" }).kind).toBe("refuse");
    expect(planCheck(BRANCH, "1111111", ok).kind).toBe("refuse");
    expect(planCheck(BRANCH, "b0ab3b3", { ...ok, clean: false }).kind).toBe("refuse");
  });
});

describe("planOpenPr", () => {
  const body = "Summary\n\nIssue: #61\n";
  const open = (existing: Parameters<typeof planOpenPr>[5]) =>
    planOpenPr(61, BRANCH, "OMI-050: skills", "body.md", body, existing);

  it("never creates a second PR when an open or merged one exists", () => {
    const pr = { number: 62, url: "u", baseRefName: "develop" };
    expect(open([{ ...pr, state: "OPEN" }]).kind).toBe("done");
    expect(open([{ ...pr, state: "MERGED" }]).kind).toBe("done");
  });

  it("creates a PR into develop when only closed PRs exist", () => {
    const plan = open([{ number: 60, state: "CLOSED", url: "u", baseRefName: "develop" }]);
    expect(steps(plan)[0]?.argv).toEqual([
      "gh",
      "pr",
      "create",
      "-R",
      "omi-hub-services/omi",
      "--base",
      "develop",
      "--head",
      BRANCH,
      "--title",
      "OMI-050: skills",
      "--body-file",
      "body.md",
    ]);
  });

  it("refuses a body without the matching `Issue: #N` line", () => {
    expect(planOpenPr(61, BRANCH, "t", "b", "Fixes #61", []).kind).toBe("refuse");
    expect(planOpenPr(61, BRANCH, "t", "b", "Issue: #6", []).kind).toBe("refuse");
    expect(planOpenPr(61, BRANCH, "t", "b", "Issue: #610", []).kind).toBe("refuse");
    expect(planOpenPr(61, BRANCH, " ", "b", body, []).kind).toBe("refuse");
  });
});

/** A comment as GitHub returns it; the Coordinator account unless another author is given. */
const by = (body: string, author: string | null = COORDINATOR_LOGIN) => ({ author, body });
const pass = (head: string, extra = "", author?: string | null) =>
  by(
    `## Independent agent review\n\n**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\`\n${extra}`,
    author,
  );
const fail = (head: string) => by(`**VERDICT:** FAIL · **REVIEWED_HEAD:** \`${head}\``);

describe("planMerge", () => {
  const green: PullForMerge = {
    number: 62,
    title: "OMI-050: skills",
    state: "OPEN",
    isDraft: false,
    headRefName: BRANCH,
    baseRefName: "develop",
    headRefOid: HEAD,
    body: "Issue: #61",
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    mergeCommit: null,
    comments: [by("looks fine"), pass(HEAD)],
    checks: [
      { name: "check", state: "pass" },
      { name: "issue-link", state: "pass" },
    ],
  };
  const required = ["check", "issue-link"];

  it("merges with a merge commit pinned to the full reviewed head", () => {
    expect(argvs(planMerge(green, "b0ab3b3", required))).toEqual([
      `gh pr merge 62 -R omi-hub-services/omi --merge --match-head-commit ${HEAD}`,
    ]);
  });

  it("is done when already merged at the reviewed head, refused at another head", () => {
    const merged = { ...green, state: "MERGED", mergeCommit: "53b5485aaaa" };
    expect(planMerge(merged, "b0ab3b3", required).kind).toBe("done");
    expect(planMerge(merged, "1111111", required).kind).toBe("refuse");
  });

  it.each<[string, Partial<PullForMerge>]>([
    ["head moved after review", { headRefOid: "2222222222222222222222222222222222222222" }],
    ["release PR into main", { baseRefName: "main" }],
    ["draft", { isDraft: true }],
    ["closed", { state: "CLOSED" }],
    [
      "failing check",
      {
        checks: [
          { name: "check", state: "fail" },
          { name: "issue-link", state: "pass" },
        ],
      },
    ],
    [
      "pending check",
      {
        checks: [
          { name: "check", state: "pending" },
          { name: "issue-link", state: "pass" },
        ],
      },
    ],
    ["required check missing", { checks: [{ name: "check", state: "pass" }] }],
  ])("refuses: %s", (_label, change) => {
    expect(planMerge({ ...green, ...change }, "b0ab3b3", required).kind).toBe("refuse");
  });

  it.each<[string, ReturnType<typeof by>[], RegExp]>([
    [
      "no agent review at all",
      [by("LGTM")],
      /needs an agent review PASS on head b0ab3b3 \(none found/,
    ],
    ["PASS on an older head", [pass("1111111")], /newest: PASS @1111111/],
    ["newest review is FAIL on the head", [pass(HEAD), fail(HEAD)], /newest: FAIL @b0ab3b3/],
  ])("refuses without an agent PASS on the exact head: %s", (_label, comments, reason) => {
    expect(planMerge({ ...green, comments }, "b0ab3b3", required)).toEqual({
      kind: "refuse",
      reason: expect.stringMatching(reason) as unknown,
    });
  });

  it("counts only the Coordinator's VERDICT comments", () => {
    const forged = [pass(HEAD, "", "someone-else")];
    expect(planMerge({ ...green, comments: forged }, "b0ab3b3", required)).toEqual({
      kind: "refuse",
      reason: expect.stringMatching(/none found; ignored VERDICT from someone-else/) as unknown,
    });
    const ghost = [pass(HEAD, "", null)];
    expect(planMerge({ ...green, comments: ghost }, "b0ab3b3", required).kind).toBe("refuse");
    // A later FAIL from another account does not override the Coordinator's PASS either.
    const foreignFail = { ...fail(HEAD), author: "someone-else" };
    const comments = [pass(HEAD), foreignFail];
    expect(planMerge({ ...green, comments }, "b0ab3b3", required).kind).toBe("run");
  });

  it("merges when a FAIL was followed by a PASS on the new head", () => {
    const comments = [fail("1111111"), pass(HEAD.slice(0, 12))];
    expect(planMerge({ ...green, comments }, "b0ab3b3", required).kind).toBe("run");
  });

  it.each(["BEHIND", "DIRTY", "BLOCKED", "UNSTABLE", "UNKNOWN"])(
    "refuses merge state %s with the state in the reason",
    (mergeStateStatus) => {
      const plan = planMerge({ ...green, mergeStateStatus }, "b0ab3b3", required);
      expect(plan.kind === "refuse" && plan.reason).toContain(
        `merge state is ${mergeStateStatus}, not CLEAN or HAS_HOOKS`,
      );
    },
  );

  it("merges in merge state HAS_HOOKS", () => {
    const plan = planMerge({ ...green, mergeStateStatus: "HAS_HOOKS" }, "b0ab3b3", required);
    expect(plan.kind).toBe("run");
  });

  it("rejects a non-SHA head before looking at the PR", () => {
    expect(() => planMerge(green, "HEAD", required)).toThrow(/commit SHA/);
  });
});

describe("planClose", () => {
  const item = { itemId: "I", status: "In Review" };
  const body = "## Objective\n- [ ] not an AC\n\n## Acceptance criteria\n- [ ] one\n- [ ] two\n";
  const fresh = { number: 61, state: "OPEN", body, comments: ["other"] };
  const verdicts = "AC-1: met — test\nAC-2: met — run";
  const merged: ReferencingPull = {
    number: 62,
    merged: true,
    baseRefName: "develop",
    headRefOid: HEAD,
    mergedAt: "2026-11-10T10:00:00Z",
    body: "Summary\n\nIssue: #61\n",
    comments: [pass(HEAD, verdicts)],
  };
  const close = (over: Partial<typeof fresh>, pulls: ReferencingPull[] = [merged]) =>
    planClose({ ...fresh, ...over }, "Evidence: PR #62 merged", field, item, pulls);
  const heads = (plan: Plan) => argvs(plan).map((a) => a.split(" ").slice(0, 3).join(" "));

  it("ticks the AC, comments once with the marker, closes, then sets Done", () => {
    const s = steps(close({}));
    expect(heads(close({}))).toEqual([
      "gh issue edit",
      "gh issue comment",
      "gh issue close",
      "gh project item-edit",
    ]);
    expect(s[0]?.argv).toEqual([
      "gh",
      "issue",
      "edit",
      "61",
      "-R",
      "omi-hub-services/omi",
      "--body-file",
      "-",
    ]);
    expect(s[0]?.input).toBe(body.replace("- [ ] one\n- [ ] two", "- [x] one\n- [x] two"));
    expect(s[1]?.input).toContain(CLOSE_EVIDENCE_MARKER);
    expect(s[1]?.argv).toContain("-");
  });

  it("is done on a re-run after everything happened, and resumes a partial run", () => {
    const posted = `Evidence\n\n${CLOSE_EVIDENCE_MARKER}`;
    const finished = { ...fresh, state: "CLOSED", comments: [posted] };
    expect(planClose(finished, "E", field, { itemId: "I", status: "Done" }, []).kind).toBe("done");
    const ticked = body.replace("- [ ] one\n- [ ] two", "- [x] one\n- [x] two");
    expect(heads(close({ body: ticked, comments: [posted] }))).toEqual([
      "gh issue close",
      "gh project item-edit",
    ]);
  });

  it.each<[string, Partial<ReferencingPull>[], RegExp]>([
    ["no merged PR links the Issue", [{ merged: false }], /no merged PR into develop/],
    ["PR links another Issue", [{ body: "Issue: #610" }], /no merged PR into develop/],
    ["PR into main", [{ baseRefName: "main" }], /no merged PR into develop/],
    ["review on an older head", [{ comments: [pass("1111111", verdicts)] }], /PASS @1111111/],
    ["review is FAIL", [{ comments: [fail(HEAD)] }], /newest: FAIL/],
    [
      "PASS posted by another account",
      [{ comments: [pass(HEAD, verdicts, "someone-else")] }],
      /none found; ignored VERDICT from someone-else/,
    ],
    ["AC line missing", [{ comments: [pass(HEAD, "AC-1: met — x")] }], /no line for AC-2/],
    [
      "AC not met",
      [{ comments: [pass(HEAD, "AC-1: met — x\nAC-2: not met — y")] }],
      /AC-2 as not met/,
    ],
  ])("refuses to close: %s", (_label, changes, reason) => {
    const plan = close(
      {},
      changes.map((c) => ({ ...merged, ...c })),
    );
    expect(plan).toEqual({ kind: "refuse", reason: expect.stringMatching(reason) as unknown });
  });

  it("uses the most recently merged PR by mergedAt, not the newest cross-reference", () => {
    const older = {
      ...merged,
      number: 50,
      mergedAt: "2026-11-09T23:59:59Z",
      comments: [fail(HEAD)],
    };
    // The older PR was cross-referenced last (e.g. mentioned again after the newer merge).
    expect(heads(close({}, [merged, older]))[0]).toBe("gh issue edit");
    expect(heads(close({}, [older, merged]))[0]).toBe("gh issue edit");
    // ...and the other way round: when the failing PR merged last, close refuses.
    const later = { ...older, mergedAt: "2026-11-10T10:00:01Z" };
    expect(close({}, [later, merged])).toEqual({
      kind: "refuse",
      reason: expect.stringMatching(/^PR #50 needs an agent review PASS/) as unknown,
    });
  });

  it("refuses an empty comment or an Issue outside the Project before doing anything", () => {
    expect(planClose(fresh, "  \n", field, item, [merged]).kind).toBe("refuse");
    expect(planClose(fresh, "Evidence", field, null, [merged]).kind).toBe("refuse");
  });
});

describe("planCleanup", () => {
  const merged: CleanupState = {
    current: "develop",
    local: "abc",
    dirty: false,
    merged: true,
    clean: true,
  };

  it("deletes a merged branch, leaving it first if it is checked out", () => {
    expect(argvs(planCleanup(BRANCH, "wsl", merged))).toEqual([`git branch -D ${BRANCH}`]);
    expect(argvs(planCleanup(BRANCH, "host", { ...merged, current: BRANCH }))).toEqual([
      "git switch develop",
      "git merge --ff-only origin/develop",
      `git branch -D ${BRANCH}`,
    ]);
  });

  it("is done when the branch or the checkout is already gone", () => {
    expect(planCleanup(BRANCH, "wsl", { ...merged, local: null }).kind).toBe("done");
    expect(planCleanup(BRANCH, "host", null).kind).toBe("done");
  });

  it("refuses unmerged work and a checked-out branch with untracked files", () => {
    expect(planCleanup(BRANCH, "wsl", { ...merged, merged: false }).kind).toBe("refuse");
    expect(planCleanup(BRANCH, "wsl", { ...merged, current: BRANCH, clean: false }).kind).toBe(
      "refuse",
    );
  });
});

describe("toCommands", () => {
  const windows: WslTarget = { viaWslExe: true, distro: "Ubuntu-24.04", repoDir: "/home/u/omi" };

  it("sends consecutive WSL steps as one wsl.exe call and keeps gh steps as argv", () => {
    const commands = toCommands(
      [
        { side: "wsl", argv: ["git", "fetch", "origin"] },
        { side: "wsl", argv: ["git", "switch", "--no-track", "-c", BRANCH, "origin/develop"] },
        { side: "host", argv: ["gh", "issue", "comment", "61", "--body-file", "-"], input: "x" },
        { side: "host", argv: ["git", "branch", "-D", BRANCH] },
      ],
      windows,
      "C:\\omi",
    );
    expect(commands).toEqual([
      {
        file: "wsl.exe",
        args: [
          "-d",
          "Ubuntu-24.04",
          "--cd",
          "/home/u/omi",
          "--exec",
          "bash",
          "-lc",
          `git fetch origin && git switch --no-track -c ${BRANCH} origin/develop`,
        ],
      },
      { file: "gh", args: ["issue", "comment", "61", "--body-file", "-"], input: "x" },
      { file: "git", args: ["branch", "-D", BRANCH], cwd: "C:\\omi" },
    ]);
  });

  it("loads nvm only for steps that need Node, with a Windows-safe payload", () => {
    const [cmd] = toCommands(
      [{ side: "wsl", argv: ["npm", "run", "check"], needsNode: true }],
      windows,
      ".",
    );
    const payload = cmd?.args.at(-1) ?? "";
    expect(payload).toMatch(/nvm\.sh .*; npm run check$/);
    expect(payload).not.toMatch(/["\\]/);
  });
});
