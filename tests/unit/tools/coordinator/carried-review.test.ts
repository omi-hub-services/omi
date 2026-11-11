import { describe, expect, it } from "vitest";
import { acLines } from "../../../../tools/coordinator/acceptance-criteria.ts";
import { COORDINATOR_LOGIN } from "../../../../tools/coordinator/coordinator-settings.ts";
import {
  agentReviewOn,
  classifyReview,
  formatAgentReview,
  latestAgentReview,
} from "../../../../tools/coordinator/github-snapshot.ts";

const OLD = "a0b1c2d3e4f5a6b7c8d9a0b1c2d3e4f5a6b7c8d9";
const NEW = "b0ab3b3b1aa20def858c14f954303c6cc63178bc";
const by = (body: string, author: string | null = COORDINATOR_LOGIN) => ({ author, body });
const plain = (head: string) => by(`**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\``);
const carried = (head: string, from: string) =>
  by(`**VERDICT:** PASS · **REVIEWED_HEAD:** \`${head}\` · **CARRIED_FROM:** \`${from}\``);

describe("CARRIED_FROM in a review comment", () => {
  it("is read from the VERDICT line", () => {
    expect(latestAgentReview([carried(NEW, OLD)])).toMatchObject({ head: NEW, carriedFrom: OLD });
    expect(latestAgentReview([plain(NEW)])?.carriedFrom).toBeNull();
  });

  it("is ignored when it appears below the VERDICT line", () => {
    const sneaky = by(
      `**VERDICT:** PASS · **REVIEWED_HEAD:** \`${NEW}\`\nCARRIED_FROM: \`${OLD}\``,
    );
    expect(latestAgentReview([sneaky])?.carriedFrom).toBeNull();
  });
});

describe("agentReviewOn", () => {
  it("finds the newest Coordinator review on a commit, full or abbreviated", () => {
    const comments = [plain(OLD), carried(NEW, OLD), by("LGTM")];
    expect(agentReviewOn(comments, OLD)?.carriedFrom).toBeNull();
    expect(agentReviewOn(comments, NEW)?.carriedFrom).toBe(OLD);
    expect(agentReviewOn([plain(NEW.slice(0, 7))], NEW)?.head).toBe(NEW.slice(0, 7));
    expect(agentReviewOn(comments, "c".repeat(40))).toBeNull();
  });

  it("takes the newest comment on that commit and ignores other accounts", () => {
    const fail = by(`**VERDICT:** FAIL · **REVIEWED_HEAD:** \`${OLD}\``);
    expect(agentReviewOn([plain(OLD), fail], OLD)?.verdict).toBe("FAIL");
    const forged = [{ ...plain(NEW), author: "someone-else" }];
    expect(agentReviewOn(forged, NEW)).toBeNull();
  });
});

describe("status wording of a carried PASS", () => {
  const view = (comments: ReturnType<typeof by>[], head = NEW) =>
    formatAgentReview(classifyReview({ reviewDecision: null, headRefOid: head, comments }).agent);

  it("shows PASS @head (carried from <sha7>)", () => {
    expect(view([carried(NEW, OLD)])).toBe("agent PASS @head (carried from a0b1c2d)");
  });

  it("keeps the ordinary wording for other reviews", () => {
    expect(view([plain(NEW)])).toBe("agent PASS @head");
    expect(view([plain(OLD)])).toBe("agent PASS @a0b1c2d (stale)");
    expect(view([])).toBe("no agent review");
  });

  it("does not claim 'carried' on a stale carried PASS", () => {
    expect(view([carried(OLD, NEW)])).toBe("agent PASS @a0b1c2d (stale)");
  });
});

describe("acLines", () => {
  it("returns only the AC lines, verbatim and in order", () => {
    const review = "## Review\n- AC-1: met — x\n  AC-2: not met — y\nAC-3 is fine\nAC-3: met — z";
    expect(acLines(review)).toEqual(["- AC-1: met — x", "  AC-2: not met — y", "AC-3: met — z"]);
  });
});
