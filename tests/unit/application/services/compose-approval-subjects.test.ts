import { describe, expect, it } from "vitest";
import { composeApprovalSubjects } from "../../../../src/application/services/compose-approval-subjects.ts";
import type { ApprovalSubject } from "../../../../src/domain/approvals/approval.ts";

const business: ApprovalSubject = {
  kind: "business",
  baselineHash: "a".repeat(64),
  scopeIds: ["t"],
};
const deploy: ApprovalSubject = {
  kind: "deploy",
  artifactDigest: `sha256:${"b".repeat(64)}`,
  environment: "sandbox",
};

describe("compose approval subjects", () => {
  const reads: string[] = [];
  const subjects = composeApprovalSubjects({
    business: {
      read: (id) => {
        reads.push(`business:${id}`);
        return business;
      },
    },
    deploy: {
      read: (id) => {
        reads.push(`deploy:${id}`);
        return deploy;
      },
    },
  });

  it("asks only the reader that owns the kind", () => {
    expect(subjects.read("x", "business")).toBe(business);
    expect(subjects.read("y", "deploy")).toBe(deploy);
    expect(reads).toEqual(["business:x", "deploy:y"]);
  });

  it("fails closed for kinds no reader owns", () => {
    expect(subjects.read("x", "cost")).toBeUndefined();
    expect(subjects.read("x", "release")).toBeUndefined();
  });
});
