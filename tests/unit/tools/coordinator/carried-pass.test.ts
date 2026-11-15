import { describe, expect, it } from "vitest";
import {
  carriedComment,
  conflictRefusal,
  decideSync,
  judgeCarriedHead,
  parseMergeTree,
  wrongHeadCarry,
  type CarryFacts,
  type CarryJudgement,
  type SyncState,
} from "../../../../tools/coordinator/carried-pass.ts";
import { latestAgentReview } from "../../../../tools/coordinator/github-snapshot.ts";
import { COORDINATOR_LOGIN } from "../../../../tools/coordinator/coordinator-settings.ts";

const OLD = "a".repeat(40);
const DEV = "d".repeat(40);
const NEW = "e".repeat(40);
const TREE = "1".repeat(40);

const facts = (change: Partial<CarryFacts> = {}): CarryFacts => ({
  head: NEW,
  parents: [OLD, DEV],
  secondParentOnDevelop: true,
  headTree: TREE,
  mergeTree: TREE,
  ...change,
});

describe("judgeCarriedHead", () => {
  it("accepts the automatic merge of the reviewed commit and a develop commit", () => {
    expect(judgeCarriedHead(facts(), OLD)).toEqual({ ok: true, developCommit: DEV });
    expect(judgeCarriedHead(facts(), OLD.slice(0, 7)).ok).toBe(true);
  });

  it.each<[string, Partial<CarryFacts>, RegExp]>([
    ["a plain commit", { parents: [OLD] }, /not a merge commit \(1 parents\)/],
    ["a root commit", { parents: [] }, /not a merge commit \(0 parents\)/],
    ["an octopus merge", { parents: [OLD, DEV, "f".repeat(40)] }, /\(3 parents\)/],
    [
      "another first parent",
      { parents: ["b".repeat(40), DEV] },
      /first parent .* bbbbbbb, not .* aaaaaaa/,
    ],
    ["develop as first parent", { parents: [DEV, OLD] }, /first parent .* ddddddd/],
    ["a second parent off develop", { secondParentOnDevelop: false }, /not on origin\/develop/],
    ["a conflicting merge", { mergeTree: null }, /conflicts, so eeeeeee is not automatic/],
    [
      "a hand-edited merge commit",
      { headTree: "2".repeat(40) },
      /differs from the automatic merge .*hand or a conflict resolution/,
    ],
  ])("rejects %s", (_label, change, reason) => {
    const judged = judgeCarriedHead(facts(change), OLD);
    expect(judged).toEqual({ ok: false, reason: expect.stringMatching(reason) as unknown });
  });
});

describe("wrongHeadCarry", () => {
  it("names the head, the source and why", () => {
    const text = wrongHeadCarry(
      { head: NEW, carriedFrom: OLD },
      { ok: false, reason: "tree differs" },
    );
    expect(text).toBe(
      "wrong-head PASS: PASS @eeeeeee carried from aaaaaaa is not a clean sync with develop (tree differs)",
    );
    expect(wrongHeadCarry({ head: NEW, carriedFrom: OLD }, undefined)).toContain("not verified");
  });
});

describe("parseMergeTree", () => {
  it("reads the tree of a clean merge", () => {
    expect(parseMergeTree(0, `${TREE}\n`)).toEqual({ clean: true, tree: TREE });
    expect(parseMergeTree(0, `${TREE}\n\nAuto-merging f.txt\n`)).toEqual({
      clean: true,
      tree: TREE,
    });
  });

  it("lists the conflicted files once, up to the first blank line", () => {
    const out = `${TREE}\na.txt\nb/c.txt\na.txt\n\nAuto-merging a.txt\nCONFLICT (content): x\n`;
    expect(parseMergeTree(1, out)).toEqual({ clean: false, files: ["a.txt", "b/c.txt"] });
  });

  it("throws on other exits or a missing tree instead of calling it a conflict", () => {
    expect(() => parseMergeTree(129, "", "usage: git merge-tree")).toThrow(/exited 129.*usage/);
    expect(() => parseMergeTree(0, "garbage\n")).toThrow(/no tree/);
  });
});

describe("conflictRefusal", () => {
  it("lists the files and points at the reduced review", () => {
    const text = conflictRefusal("task/omi-001-x", ["a.ts", "b.ts"]);
    expect(text).toContain("conflicted files: a.ts, b.ts");
    expect(text).toContain("ADR-0014");
  });
});

describe("carriedComment", () => {
  const review = [
    "## Independent agent review",
    "**VERDICT:** PASS · **REVIEWED_HEAD:** `" + OLD + "`",
    "- AC-1: met — tests",
    "AC-2: met — docs",
    "prose that mentions AC-3: met in passing",
  ].join("\n");
  const body = carriedComment({
    newHead: NEW,
    reviewed: OLD,
    oldReviewBody: review,
    developCommit: DEV,
    checkNote: "ok",
  });

  it("parses as a PASS on the new head carried from the old one", () => {
    expect(latestAgentReview([{ author: COORDINATOR_LOGIN, body }])).toMatchObject({
      verdict: "PASS",
      head: NEW,
      carriedFrom: OLD,
    });
  });

  it("copies the old AC lines verbatim and records merge commit, develop commit and check", () => {
    expect(body).toContain("- AC-1: met — tests\nAC-2: met — docs\n");
    expect(body).not.toContain("prose that mentions");
    expect(body).toContain(`Merge commit: \`${NEW}\``);
    expect(body).toContain(`commit merged in: \`${DEV}\``);
    expect(body).toContain("Check: ok");
  });
});

describe("decideSync", () => {
  const ok: CarryJudgement = { ok: true, developCommit: DEV };
  const no = (reason: string): CarryJudgement => ({ ok: false, reason });
  const review = (head: string, verdict = "PASS", carriedFrom: string | null = null) => ({
    verdict,
    head,
    body: "",
    carriedFrom,
  });
  const base: SyncState = {
    branch: "task/omi-001-x",
    reviewed: OLD,
    current: "task/omi-001-x",
    head: OLD,
    clean: true,
    remote: OLD,
    pull: { number: 7, comments: [] },
    developInHead: false,
    newest: review(OLD),
    reviewedPass: ok,
    headCarry: null,
    headPass: null,
  };
  const reason = (change: Partial<SyncState>) => {
    const d = decideSync({ ...base, ...change });
    return d.kind === "refuse" ? d.reason : d.kind;
  };

  it("merges when head is the reviewed commit with a Coordinator PASS", () => {
    expect(decideSync(base)).toEqual({ kind: "merge" });
    expect(decideSync({ ...base, reviewed: OLD.slice(0, 7) })).toEqual({ kind: "merge" });
  });

  it.each<[string, Partial<SyncState>, RegExp]>([
    ["wrong checkout", { current: "develop" }, /checkout is on develop/],
    ["dirty checkout", { clean: false }, /uncommitted or untracked/],
    ["no open PR", { pull: null }, /no open PR/],
    [
      "head is another commit",
      { head: "b".repeat(40), headCarry: null },
      /at bbbbbbb, not the reviewed aaaaaaa/,
    ],
    [
      "head is a hand-edited merge",
      { head: NEW, headCarry: no("tree differs") },
      /not the reviewed aaaaaaa: tree differs/,
    ],
    ["branch not pushed at head", { remote: "c".repeat(40) }, /origin\/.* is at ccccccc/],
    ["branch missing on origin", { remote: null }, /is at none/],
    ["no review at all", { newest: null }, /not a PASS on aaaaaaa \(newest: none\)/],
    ["newest review is FAIL", { newest: review(OLD, "FAIL") }, /newest: FAIL @aaaaaaa/],
    ["newest PASS is on another commit", { newest: review("b".repeat(40)) }, /PASS|bbbbbbb/],
    [
      "PASS chain broken in git",
      { reviewedPass: no("tree differs") },
      /no valid PASS on aaaaaaa \(tree differs\)/,
    ],
  ])("refuses: %s", (_label, change, expected) => {
    expect(reason(change)).toMatch(expected);
  });

  it("is done when develop is already in the branch", () => {
    expect(decideSync({ ...base, developInHead: true }).kind).toBe("done");
  });

  describe("re-run after a sync (head is the merge commit)", () => {
    const merged = { head: NEW, headCarry: ok, newest: review(NEW, "PASS", OLD) };

    it("is done once the carried PASS is on head and head is pushed", () => {
      expect(decideSync({ ...base, ...merged, headPass: ok, remote: NEW }).kind).toBe("done");
    });

    it("resumes with the push when the PASS is posted but head is not pushed", () => {
      expect(decideSync({ ...base, ...merged, headPass: ok })).toEqual({
        kind: "resume",
        commented: true,
      });
    });

    it("resumes with check, push and comment when no PASS is on head yet", () => {
      expect(decideSync({ ...base, ...merged, newest: review(OLD) })).toEqual({
        kind: "resume",
        commented: false,
      });
    });

    it("refuses to resume when the PASS on the reviewed commit is not valid", () => {
      expect(reason({ ...merged, reviewedPass: no("no review") })).toMatch(
        /no valid Coordinator PASS/,
      );
    });

    it("does not call a forged carried PASS done", () => {
      expect(reason({ ...merged, headPass: no("tree differs"), reviewedPass: no("x") })).toMatch(
        /no valid Coordinator PASS/,
      );
    });
  });
});
