import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { judgeCarryChain } from "../../../../tools/coordinator/carry-git.ts";
import { COORDINATOR_LOGIN } from "../../../../tools/coordinator/coordinator-settings.ts";
import { syncCommand, type Context } from "../../../../tools/coordinator/flow.ts";
import { localGit } from "../../../../tools/coordinator/git-probe.ts";
import {
  createProcessRunner,
  type Command,
  type Runner,
} from "../../../../tools/coordinator/process-runner.ts";

// Real git (merge, merge-tree, push to a bare origin); only `gh` and `npm run check` are faked.
const BRANCH = "task/omi-069-x";
const AC = "- AC-1: met — a\nAC-2: met — b";

let root = "";
let work = "";
let origin = "";
let comments: { author: string; body: string }[] = [];
let posted: Command[] = [];
let checkCode = 0;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const inWork = (...args: string[]) => git(work, ...args);
const commit = (file: string, text: string, message: string) => {
  writeFileSync(join(work, file), text);
  inWork("add", file);
  inWork("commit", "-q", "-m", message);
};

const review = (head: string) => ({
  author: COORDINATOR_LOGIN,
  body: `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\`\n${AC}\n`,
});

function fakeContext(): Context {
  const real = createProcessRunner();
  const run: Runner = async (command) => {
    if (command.file === "gh") {
      const joined = command.args.join(" ");
      if (joined.startsWith("pr list")) {
        const open = [{ number: 5, state: "OPEN", url: "u", baseRefName: "develop" }];
        return { code: 0, stdout: JSON.stringify(open), stderr: "" };
      }
      if (joined.startsWith("api graphql")) {
        const pr = {
          number: 5,
          title: "t",
          isDraft: false,
          headRefName: BRANCH,
          headRefOid: git(origin, "rev-parse", BRANCH),
          baseRefName: "develop",
          body: "Issue: #122",
          reviewDecision: null,
          mergeStateStatus: "BEHIND",
          state: "OPEN",
          mergeCommit: null,
          comments: { nodes: comments.map((c) => ({ author: { login: c.author }, body: c.body })) },
          commits: { nodes: [] },
        };
        const data = { data: { repository: { pullRequest: pr } } };
        return { code: 0, stdout: JSON.stringify(data), stderr: "" };
      }
      if (joined.startsWith("pr comment")) {
        posted.push(command);
        comments.push({ author: COORDINATOR_LOGIN, body: command.input ?? "" });
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected gh ${joined}`);
    }
    if (command.args.at(-1)?.includes("npm run check")) {
      return { code: checkCode, stdout: "", stderr: checkCode ? "check failed" : "" };
    }
    return real(command);
  };
  return {
    run,
    target: { viaWslExe: false, distro: "-", repoDir: work },
    hostCwd: work,
    isWindows: false,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omi-carried-"));
  origin = join(root, "origin.git");
  work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "develop", origin);
  git(root, "clone", "-q", origin, work);
  inWork("config", "user.email", "t@example.invalid");
  inWork("config", "user.name", "t");
  inWork("switch", "-q", "-c", "develop");
  commit("shared.txt", "one\ntwo\nthree\n", "init");
  inWork("push", "-q", "-u", "origin", "develop");
  inWork("switch", "-q", "-c", BRANCH);
  commit("task.txt", "task\n", "task work");
  inWork("push", "-q", "-u", "origin", BRANCH);
  comments = [review(inWork("rev-parse", "HEAD"))];
  posted = [];
  checkCode = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** develop moves on after the PR was reviewed; the work checkout is left on the task branch. */
function advanceDevelop(file: string, text: string) {
  inWork("switch", "-q", "develop");
  commit(file, text, `develop: ${file}`);
  inWork("push", "-q", "origin", "develop");
  inWork("switch", "-q", BRANCH);
}

async function sync(reviewed: string, dryRun = false) {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
  vi.spyOn(console, "error").mockImplementation((m: unknown) => void out.push(String(m)));
  const code = await syncCommand(fakeContext(), BRANCH, reviewed, dryRun);
  return { code, out: out.join("\n") };
}

describe("flow sync on a real repository", () => {
  it("merges develop, checks, pushes and posts a carried PASS that git accepts", async () => {
    const reviewed = inWork("rev-parse", "HEAD");
    advanceDevelop("other.txt", "other\n");
    const { code, out } = await sync(reviewed);
    expect(code, out).toBe(0);
    const head = inWork("rev-parse", "HEAD");
    expect(inWork("rev-parse", "HEAD^1")).toBe(reviewed);
    expect(git(origin, "rev-parse", BRANCH)).toBe(head);
    expect(posted).toHaveLength(1);
    const body = posted[0]?.input ?? "";
    expect(body).toContain(`**REVIEWED_HEAD:** \`${head}\` · **CARRIED_FROM:** \`${reviewed}\``);
    expect(body).toContain(AC);
    expect(body).toContain(inWork("rev-parse", "HEAD^2"));
    expect(body).toContain("npm run check` passed");
    const judged = await judgeCarryChain(createProcessRunner(), localGit(work), comments, head);
    expect(judged.ok).toBe(true);
  });

  it("is idempotent: a re-run says done and changes nothing", async () => {
    const reviewed = inWork("rev-parse", "HEAD");
    advanceDevelop("other.txt", "other\n");
    expect((await sync(reviewed)).code).toBe(0);
    const head = inWork("rev-parse", "HEAD");
    const again = await sync(reviewed);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toMatch(/done: PASS on .* already carried/);
    expect(inWork("rev-parse", "HEAD")).toBe(head);
    expect(posted).toHaveLength(1);
  });

  it("--dry-run writes nothing: no merge, push or comment", async () => {
    const reviewed = inWork("rev-parse", "HEAD");
    advanceDevelop("other.txt", "other\n");
    const { code, out } = await sync(reviewed, true);
    expect(code, out).toBe(0);
    expect(out).toMatch(/would run: .*git merge --no-edit origin\/develop/);
    expect(out).toMatch(/would run: gh pr comment 5/);
    expect(inWork("rev-parse", "HEAD")).toBe(reviewed);
    expect(git(origin, "rev-parse", BRANCH)).toBe(reviewed);
    expect(posted).toEqual([]);
  });

  it("refuses a conflict listing the files, aborts the merge, pushes and posts nothing", async () => {
    commit("shared.txt", "one\nTASK\nthree\n", "task edits shared");
    inWork("push", "-q", "origin", BRANCH);
    const reviewed = inWork("rev-parse", "HEAD");
    comments = [review(reviewed)];
    advanceDevelop("shared.txt", "one\nDEVELOP\nthree\n");
    const { code, out } = await sync(reviewed);
    expect(code).toBe(1);
    expect(out).toMatch(/refused: .*conflicted files: shared\.txt/);
    expect(inWork("rev-parse", "HEAD")).toBe(reviewed);
    expect(inWork("status", "--porcelain")).toBe("");
    expect(() => inWork("rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
    expect(git(origin, "rev-parse", BRANCH)).toBe(reviewed);
    expect(posted).toEqual([]);
  });

  it("--dry-run also reports the conflict", async () => {
    commit("shared.txt", "one\nTASK\nthree\n", "task edits shared");
    inWork("push", "-q", "origin", BRANCH);
    const reviewed = inWork("rev-parse", "HEAD");
    comments = [review(reviewed)];
    advanceDevelop("shared.txt", "one\nDEVELOP\nthree\n");
    const { code, out } = await sync(reviewed, true);
    expect(code).toBe(1);
    expect(out).toMatch(/refused: .*conflicted files: shared\.txt/);
  });

  it("refuses when the branch head is not the reviewed commit", async () => {
    const reviewed = inWork("rev-parse", "HEAD");
    commit("more.txt", "more\n", "unreviewed commit");
    inWork("push", "-q", "origin", BRANCH);
    advanceDevelop("other.txt", "other\n");
    const { code, out } = await sync(reviewed);
    expect(code).toBe(1);
    expect(out).toMatch(/refused: .*not the reviewed/);
    expect(posted).toEqual([]);
  });

  it("refuses without a Coordinator PASS on the reviewed commit", async () => {
    const reviewed = inWork("rev-parse", "HEAD");
    comments = [{ ...review(reviewed), author: "someone-else" }];
    advanceDevelop("other.txt", "other\n");
    const { code, out } = await sync(reviewed);
    expect(code).toBe(1);
    expect(out).toMatch(/refused: .*not a PASS on/);
    expect(inWork("rev-parse", "HEAD")).toBe(reviewed);
  });

  it("does not push or comment when the check fails, and resumes on a re-run", async () => {
    const reviewed = inWork("rev-parse", "HEAD");
    advanceDevelop("other.txt", "other\n");
    checkCode = 1;
    const failed = await sync(reviewed);
    expect(failed.code).toBe(1);
    expect(git(origin, "rev-parse", BRANCH)).toBe(reviewed);
    expect(posted).toEqual([]);
    checkCode = 0;
    const resumed = await sync(reviewed);
    expect(resumed.code, resumed.out).toBe(0);
    expect(git(origin, "rev-parse", BRANCH)).toBe(inWork("rev-parse", "HEAD"));
    expect(posted).toHaveLength(1);
  });
});

describe("judgeCarryChain on real merge commits", () => {
  const judge = (head: string) =>
    judgeCarryChain(createProcessRunner(), localGit(work), comments, head);
  const carried = (head: string, from: string) => ({
    author: COORDINATOR_LOGIN,
    body: `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\` · **CARRIED_FROM:** \`${from}\`\n`,
  });

  it("accepts a clean merge and rejects the same merge once it is edited by hand", async () => {
    const reviewed = inWork("rev-parse", "HEAD");
    advanceDevelop("other.txt", "other\n");
    inWork("fetch", "-q", "origin");
    inWork("merge", "-q", "--no-edit", "origin/develop");
    const clean = inWork("rev-parse", "HEAD");
    comments.push(carried(clean, reviewed));
    expect((await judge(clean)).ok).toBe(true);

    writeFileSync(join(work, "sneaky.txt"), "not from either parent\n");
    inWork("add", "sneaky.txt");
    inWork("commit", "-q", "--amend", "--no-edit");
    const edited = inWork("rev-parse", "HEAD");
    comments.push(carried(edited, reviewed));
    expect(await judge(edited)).toEqual({
      ok: false,
      reason: expect.stringMatching(/differs from the automatic merge/) as unknown,
    });
  });

  it("rejects a merge of something that is not on origin/develop", async () => {
    const reviewed = inWork("rev-parse", "HEAD");
    inWork("switch", "-q", "-c", "side", "develop");
    commit("side.txt", "side\n", "unmerged side work");
    inWork("switch", "-q", BRANCH);
    inWork("merge", "-q", "--no-edit", "side");
    const head = inWork("rev-parse", "HEAD");
    comments.push(carried(head, reviewed));
    expect(await judge(head)).toEqual({
      ok: false,
      reason: expect.stringMatching(/not on origin\/develop/) as unknown,
    });
  });

  it("rejects a conflict resolution, which needs the reduced review instead", async () => {
    commit("shared.txt", "one\nTASK\nthree\n", "task edits shared");
    const reviewed = inWork("rev-parse", "HEAD");
    advanceDevelop("shared.txt", "one\nDEVELOP\nthree\n");
    inWork("fetch", "-q", "origin");
    expect(() => inWork("merge", "-q", "--no-edit", "origin/develop")).toThrow();
    writeFileSync(join(work, "shared.txt"), "one\nBOTH\nthree\n");
    inWork("add", "shared.txt");
    inWork("commit", "-q", "--no-edit");
    const head = inWork("rev-parse", "HEAD");
    comments.push(carried(head, reviewed));
    expect(await judge(head)).toEqual({
      ok: false,
      reason: expect.stringMatching(/conflicts, so .* is not automatic/) as unknown,
    });
  });
});
