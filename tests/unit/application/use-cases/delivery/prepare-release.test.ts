import { describe, expect, it } from "vitest";
import type { DeliveryPull } from "../../../../../src/application/contracts/pr-delivery.ts";
import { prepareRelease } from "../../../../../src/application/use-cases/delivery/prepare-release.ts";
import type { PrepareReleaseDeps } from "../../../../../src/application/use-cases/delivery/prepare-release.ts";
import { operationMarker } from "../../../../../src/domain/delivery/operation-marker.ts";
import { releasePullKey } from "../../../../../src/domain/delivery/release-policy.ts";
import type { MergedPull } from "../../../../../src/domain/delivery/release-policy.ts";
import { preparationHarness } from "./prepare-pr-fakes.ts";

const request = { repository: "acme/app", release: "r1" };
const merged: MergedPull[] = [
  {
    number: 5,
    title: "Add thing",
    body: "Issue: #30\n",
    head: "task/omi-030-thing",
    mergedAt: "2026-11-01T00:00:00Z",
  },
];

function setup(pulls: MergedPull[] = merged, last?: string) {
  const h = preparationHarness();
  const state: { pull?: DeliveryPull } = {};
  h.github.sendScript.push({ kind: "succeeded", remoteIdentity: "issue:acme/app#50" });
  h.github.onSend = ({ operation, operationKey }) => {
    if (operation.type === "pull_request.create")
      state.pull = {
        number: 60,
        repository: operation.repo,
        head: operation.head,
        base: operation.base,
        body: `${operation.body}\n\n${operationMarker(operationKey)}`,
        state: "open",
      };
  };
  const deps: PrepareReleaseDeps = {
    ...h.deps,
    releases: {
      lastReleaseMergedAt: () => Promise.resolve(last),
      mergedReleasePulls: () => Promise.resolve([]),
      mergedDevelopPulls: () => Promise.resolve(pulls),
    },
    pulls: {
      findOpenPull: () => Promise.resolve(state.pull),
      pull: () =>
        state.pull === undefined
          ? Promise.reject(new Error("NO_PULL"))
          : Promise.resolve(state.pull),
    },
  };
  return { ...h, deps, state };
}

describe("prepareRelease", () => {
  it("creates the Release Issue with the task list, then a develop to main PR linking it", async () => {
    const h = setup();
    expect(await prepareRelease(h.deps, request)).toMatchObject({
      status: "verified",
      releaseIssueNumber: 50,
      prNumber: 60,
    });
    expect(h.github.sends.map((s) => s.operation.type)).toEqual([
      "issue.create",
      "pull_request.create",
    ]);
    const [issue, pr] = h.github.sends.map((s) => s.operation);
    expect(issue).toMatchObject({ type: "issue.create" });
    expect(JSON.stringify(issue)).toContain("OMI-030 · Issue #30 · PR #5");
    expect(pr).toMatchObject({ head: "develop", base: "main" });
    expect(h.state.pull?.body).toContain("Release Issue: #50");
  });
  it("retries without a second send", async () => {
    const h = setup();
    await prepareRelease(h.deps, request);
    await prepareRelease(h.deps, request);
    expect(h.github.sends).toHaveLength(2);
  });
  it("never sends anything but issue.create and pull_request.create", async () => {
    const h = setup();
    await prepareRelease(h.deps, request);
    expect(
      h.github.sends.every((s) =>
        ["issue.create", "pull_request.create"].includes(s.operation.type),
      ),
    ).toBe(true);
  });
  it("refuses an empty release before any write", async () => {
    const h = setup(merged, "2026-11-02T00:00:00Z");
    await expect(prepareRelease(h.deps, request)).rejects.toThrow("RELEASE_EMPTY");
    expect(h.github.sends).toHaveLength(0);
  });
  it("refuses a closing reference smuggled through a PR title", async () => {
    const h = setup([{ ...(merged[0] as MergedPull), title: "Closes #1" }]);
    await expect(prepareRelease(h.deps, request)).rejects.toThrow("CLOSING_REFERENCE_FORBIDDEN");
    expect(h.github.sends).toHaveLength(0);
  });
  it("refuses an unrelated open develop to main PR instead of overwriting it", async () => {
    const h = setup();
    h.state.pull = {
      number: 99,
      repository: "acme/app",
      head: "develop",
      base: "main",
      body: "someone else",
      state: "open",
    };
    await expect(prepareRelease(h.deps, request)).rejects.toThrow("PR_VERIFICATION_FAILED");
    expect(h.github.sends.map((s) => s.operation.type)).toEqual(["issue.create"]);
  });
  it("refuses an Issue identity that is not for this repository", async () => {
    const h = setup();
    h.github.sendScript.length = 0;
    h.github.sendScript.push({ kind: "succeeded", remoteIdentity: "issue:other/app#50" });
    await expect(prepareRelease(h.deps, request)).rejects.toThrow("RELEASE_ISSUE_UNVERIFIED");
    expect(h.github.sends).toHaveLength(1);
  });
  it("uses a stable PR key per release", () => {
    expect(releasePullKey("acme/app", "r1")).toBe("create-release-pr:acme/app:r1:develop:main");
  });
});
