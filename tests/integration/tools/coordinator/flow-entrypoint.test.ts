import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("runs the documented plain Node flow command without a module resolution error", () => {
  const result = spawnSync("node", ["tools/coordinator/flow.ts", "--help"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("promote");
});
