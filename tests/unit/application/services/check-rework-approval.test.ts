import { expect, it } from "vitest";
import * as authorization from "../../../../src/application/services/check-rework-approval.ts";
import type { MergePull } from "../../../../src/application/contracts/merge-delivery.ts";

it("uses the mapped PR author instead of the runtime's GitHub actor", async () => {
  const deps = {
    plans: {
      forRun: () => ({
        projectId: "p",
        taskId: "task",
        repository: "acme/app",
        issueNumber: 1,
        templateHash: "h",
      }),
    },
    mappings: {
      get: () => ({
        projectId: "p",
        taskId: "task",
        repository: "acme/app",
        issueNumber: 1,
        prNumber: 2,
      }),
    },
    reader: {
      authenticatedActor: () => Promise.resolve("coordinator"),
      pull: (): Promise<MergePull> =>
        Promise.resolve({
          number: 2,
          repository: "acme/app",
          state: "open",
          merged: false,
          headSha: "a".repeat(40),
          headRef: "task/omi-116",
          baseRef: "develop",
          author: "developer",
          mergeableState: "clean",
          mergeCommitSha: null,
          body: "Issue: #1",
        }),
    },
  };
  expect(await authorization.readReworkAuthor(deps, "run")).toBe("developer");
});
