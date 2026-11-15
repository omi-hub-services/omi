import { describe, expect, it } from "vitest";
import { judgeCarryChain, readCarryFacts } from "../../../../tools/coordinator/carry-git.ts";
import { COORDINATOR_LOGIN } from "../../../../tools/coordinator/coordinator-settings.ts";
import { localGit } from "../../../../tools/coordinator/git-probe.ts";
import type { Command, Runner } from "../../../../tools/coordinator/process-runner.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D1 = "d".repeat(40);
const D2 = "e".repeat(40);
const T = "1".repeat(40);
const by = (body: string) => ({ author: COORDINATOR_LOGIN, body });
const plain = (head: string) => by(`**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\``);
const carried = (head: string, from: string) =>
  by(`**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\` · **CARRIED_FROM:** \`${from}\``);

interface Commit {
  readonly parents: string[];
  readonly tree: string;
  /** Tree `git merge-tree` builds for the parents; the word "conflict" for a conflicting merge. */
  readonly mergeTree?: string;
  /** The commit is on origin/develop (default true). */
  readonly onDevelop?: boolean;
}

/** A runner that answers the few git reads carry-git.ts makes from a table of commits. */
function fakeGit(commits: Record<string, Commit>): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = (command: Command) => {
    const args = [...command.args];
    calls.push(args);
    const at = (sha: string | undefined) => commits[sha ?? ""];
    const out = (stdout: string, code = 0, stderr = "") =>
      Promise.resolve({ code, stdout, stderr });
    if (args[0] === "rev-list") {
      const c = at(args.at(-1));
      if (!c) return out("", 128, "bad object");
      return out(`${args.at(-1) ?? ""} ${c.parents.join(" ")}\n`);
    }
    if (args[0] === "show") return out(`${at(args.at(-1))?.tree ?? ""}\n`);
    if (args[0] === "merge-base") {
      return out("", commits[args[2] ?? ""]?.onDevelop === false ? 1 : 0);
    }
    if (args[0] === "merge-tree") {
      const merged = Object.values(commits).find(
        (c) => c.parents[0] === args.at(-2) && c.parents[1] === args.at(-1),
      )?.mergeTree;
      if (merged === "conflict") return out(`${T}\nf.txt\n\nCONFLICT\n`, 1);
      return out(`${merged ?? T}\n`);
    }
    return out("", 1, `unexpected git ${args.join(" ")}`);
  };
  return { run, calls };
}

const git = localGit("/unused");

describe("readCarryFacts", () => {
  it("reads parents, develop membership, tree and automatic-merge tree", async () => {
    const { run } = fakeGit({
      [B]: { parents: [A, D1], tree: T, mergeTree: T },
      [D1]: { parents: [], tree: T, onDevelop: false },
    });
    expect(await readCarryFacts(run, git, B)).toEqual({
      head: B,
      parents: [A, D1],
      secondParentOnDevelop: false,
      headTree: T,
      mergeTree: T,
    });
  });

  it("does not run merge-tree for a commit that is not a two-parent merge", async () => {
    const { run, calls } = fakeGit({ [B]: { parents: [A], tree: T } });
    const facts = await readCarryFacts(run, git, B);
    expect(facts).toMatchObject({ parents: [A], mergeTree: null, secondParentOnDevelop: false });
    expect(calls.some((c) => c[0] === "merge-tree")).toBe(false);
  });

  it("reports a conflicting parent merge as null", async () => {
    const { run } = fakeGit({ [B]: { parents: [A, D1], tree: T, mergeTree: "conflict" } });
    expect((await readCarryFacts(run, git, B)).mergeTree).toBeNull();
  });

  it("throws when a read fails instead of guessing", async () => {
    const { run } = fakeGit({});
    await expect(readCarryFacts(run, git, B)).rejects.toThrow(/exited 128/);
  });
});

describe("judgeCarryChain", () => {
  const sync = (parents: string[], over: Partial<Commit> = {}): Commit => ({
    parents,
    tree: T,
    mergeTree: T,
    onDevelop: true,
    ...over,
  });

  it("accepts an ordinary PASS without reading git", async () => {
    const { run, calls } = fakeGit({});
    expect(await judgeCarryChain(run, git, [plain(A)], A)).toEqual({ ok: true, developCommit: "" });
    expect(calls).toEqual([]);
  });

  it("accepts a carried PASS on a clean sync", async () => {
    const { run } = fakeGit({
      [B]: sync([A, D1]),
      [D1]: { parents: [], tree: T, onDevelop: true },
    });
    expect(await judgeCarryChain(run, git, [plain(A), carried(B, A)], B)).toEqual({
      ok: true,
      developCommit: D1,
    });
  });

  it("accepts a chain of two syncs and rejects it when the earlier hop was edited", async () => {
    const commits = (middle: Partial<Commit>): Record<string, Commit> => ({
      [B]: sync([A, D1], middle),
      [C]: sync([B, D2]),
      [D1]: { parents: [], tree: T, onDevelop: true },
      [D2]: { parents: [], tree: T, onDevelop: true },
    });
    const comments = [plain(A), carried(B, A), carried(C, B)];
    expect(await judgeCarryChain(fakeGit(commits({})).run, git, comments, C)).toMatchObject({
      ok: true,
    });
    const edited = commits({ mergeTree: "2".repeat(40) });
    expect(await judgeCarryChain(fakeGit(edited).run, git, comments, C)).toEqual({
      ok: false,
      reason: expect.stringMatching(/differs from the automatic merge/) as unknown,
    });
  });

  it("rejects a hand-edited merge commit", async () => {
    const { run } = fakeGit({ [B]: sync([A, D1], { tree: "2".repeat(40) }) });
    expect(await judgeCarryChain(run, git, [plain(A), carried(B, A)], B)).toEqual({
      ok: false,
      reason: expect.stringMatching(/hand or a conflict resolution/) as unknown,
    });
  });

  it("rejects a carried PASS whose source has no PASS of its own", async () => {
    const { run } = fakeGit({ [B]: sync([A, D1]) });
    expect(await judgeCarryChain(run, git, [carried(B, A)], B)).toEqual({
      ok: false,
      reason: expect.stringMatching(/no Coordinator PASS on aaaaaaa \(no review\)/) as unknown,
    });
  });

  it("rejects a source whose newest review is a FAIL", async () => {
    const fail = by(`**VERDICT:** FAIL · **REVIEWED_HEAD:** \`${A}\``);
    const { run } = fakeGit({ [B]: sync([A, D1]) });
    const judged = await judgeCarryChain(run, git, [plain(A), fail, carried(B, A)], B);
    expect(judged).toEqual({ ok: false, reason: expect.stringMatching(/\(FAIL\)/) as unknown });
  });

  it("rejects a claim about a different parent", async () => {
    const { run } = fakeGit({ [B]: sync([C, D1]) });
    const judged = await judgeCarryChain(run, git, [plain(A), carried(B, A)], B);
    expect(judged).toEqual({ ok: false, reason: expect.stringMatching(/first parent/) as unknown });
  });

  it("refuses rather than throws when git cannot read the commit", async () => {
    const { run } = fakeGit({});
    const judged = await judgeCarryChain(run, git, [plain(A), carried(B, A)], B);
    expect(judged).toEqual({
      ok: false,
      reason: expect.stringMatching(/cannot read bbbbbbb from git/) as unknown,
    });
  });

  it("stops a self-referencing chain", async () => {
    const { run } = fakeGit({ [B]: sync([B, D1]) });
    const judged = await judgeCarryChain(run, git, [carried(B, B)], B);
    expect(judged).toEqual({ ok: false, reason: expect.stringMatching(/longer than/) as unknown });
  });
});
