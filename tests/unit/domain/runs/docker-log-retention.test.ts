import { expect, it } from "vitest";
import { planLogRetention } from "../../../../src/domain/runs/log-retention-policy.js";

it("compresses the newest finished Docker log at task cleanup", () => {
  const decisions = planLogRetention(
    {
      now: 1000,
      root: [
        {
          name: "omi-156-test.jsonl",
          taskId: "156",
          profile: "test",
          size: 100,
          mtimeMs: 1000,
          running: false,
        },
      ],
      archive: [],
    },
    new Set(["156"]),
    { recentMinutes: 10, archiveMaxBytes: 10000, archiveMaxAgeDays: 30 },
    true,
  );
  expect(decisions[0]?.action).toBe("archive");
});
