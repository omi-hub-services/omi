import { describe, expect, it } from "vitest";
import {
  assembleLiveConfig,
  isPlaceholder,
  nextSteps,
  parseLivePrepFlags,
} from "../../../../tools/sandbox-setup/live-prep.ts";

const facts = {
  repository: "omi-hub-services/omi-sandbox",
  acceptanceId: "acceptance-042-a",
  stateDirectory: "/tmp/state",
  projectId: "project-1",
  taskId: "task-7",
  idea: "Acceptance task",
  issueBody: "## Acceptance criteria\n- [ ] x",
  baselineHash: "a".repeat(64),
  artifactDigest: `sha256:${"b".repeat(64)}`,
  pipeline: {
    workflow: "sandbox-deploy.yml",
    ref: "sandbox-deploy-r1",
    workflowSha: "c".repeat(40),
    issueNumber: 3,
    allowedActors: ["ttin-omihub"],
    authorActor: "minibox-claude-code",
  },
};

describe("parseLivePrepFlags", () => {
  const ok = { "--state-dir": "/tmp/s", "--acceptance-id": "a-1", "--issue": "7" };
  it("accepts the required flags and the optional approval ids", () => {
    expect(
      parseLivePrepFlags(
        { ...ok, "--business-approval-id": "b1", "--deploy-approval-id": "d1" },
        true,
      ),
    ).toEqual({
      stateDir: "/tmp/s",
      acceptanceId: "a-1",
      issue: 7,
      businessApprovalId: "b1",
      deployApprovalId: "d1",
      dryRun: true,
    });
  });
  it.each([
    [{ ...ok, "--issue": "0" }, /--issue/],
    [{ ...ok, "--issue": "7x" }, /--issue/],
    [{ ...ok, "--acceptance-id": "Bad_Id" }, /--acceptance-id/],
    [{ ...ok, "--state-dir": undefined }, /--state-dir/],
  ])("refuses %j", (flags, message) => {
    expect(() => parseLivePrepFlags(flags, false)).toThrow(message);
  });
});

describe("assembleLiveConfig", () => {
  it("lists the operator fields as placeholders until they are filled", () => {
    const { config, placeholders } = assembleLiveConfig(facts, {});
    expect(placeholders).toEqual([
      "businessApprovalId",
      "head",
      "evidence",
      "reviewFile",
      "deployApprovalId",
    ]);
    expect(isPlaceholder(config["head"])).toBe(true);
    expect(config["taskId"]).toBe("task-7");
    expect(config["release"]).toBe("acceptance-042-a");
  });
  it("keeps operator-filled values on a rerun and refreshes the known facts", () => {
    const existing = {
      head: "task/omi-042-a",
      evidence: ["ref-1"],
      reviewFile: "/tmp/review.json",
      taskId: "stale",
    };
    const { config, placeholders } = assembleLiveConfig(
      { ...facts, businessApprovalId: "b1", deployApprovalId: "d1" },
      existing,
    );
    expect(placeholders).toEqual([]);
    expect(config).toMatchObject({
      head: "task/omi-042-a",
      evidence: ["ref-1"],
      reviewFile: "/tmp/review.json",
      taskId: "task-7",
      businessApprovalId: "b1",
    });
  });
  it("contains no credential or decision", () => {
    expect(JSON.stringify(assembleLiveConfig(facts, {}).config)).not.toMatch(
      /token|password|secret|"approved"/i,
    );
  });
});

describe("nextSteps", () => {
  const steps = nextSteps({
    stateDir: "/tmp/state",
    taskId: "task-7",
    deployTargetId: "sandbox-a",
    pipelineIssue: 3,
    reviewer: "ttin-omihub",
  }).join("\n");
  it("names both request commands and the PO's decision path", () => {
    expect(steps).toContain("approvals request task-7 --kind business");
    expect(steps).toContain("approvals request sandbox-a --kind deploy");
    expect(steps).toContain("ttin-omihub");
    expect(steps).toContain("approvals decide <request-id> --expected-version 0");
    expect(steps).toContain("--github-comment <comment-id>");
  });
  it("tells the operator to rerun with the ids once the requests exist", () => {
    expect(steps).toContain("--business-approval-id");
    expect(steps).toContain("--deploy-approval-id");
  });
});
