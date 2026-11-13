import { describe, expect, it } from "vitest";
import { linkedIssueNumber } from "../../../../src/domain/delivery/pull-issue-link.ts";

describe("linkedIssueNumber", () => {
  it("is the Issue named by the one `Issue: #N` line", () => {
    expect(linkedIssueNumber("Summary\n\nIssue: #164\n")).toBe(164);
  });

  it("accepts the same Issue named twice", () => {
    expect(linkedIssueNumber("Issue: #7\nmore\nIssue: #7")).toBe(7);
  });

  it("is undefined when two different Issues are named", () => {
    expect(linkedIssueNumber("Issue: #1\nIssue: #2")).toBeUndefined();
  });

  it("is undefined without an Issue line or with a line that is not exactly that shape", () => {
    expect(linkedIssueNumber("")).toBeUndefined();
    expect(linkedIssueNumber("See Issue: #3 for context")).toBeUndefined();
    expect(linkedIssueNumber("Closes #3")).toBeUndefined();
  });
});
