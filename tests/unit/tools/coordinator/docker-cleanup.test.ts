import { expect, it } from "vitest";
import { planCleanup, toCommands } from "../../../../tools/coordinator/flow-plans.ts";

it("removes an accepted Docker worktree including ignored dependencies", () => {
  const plan = planCleanup("task/omi-156-docker-runtime", "wsl", {
    current: "develop",
    local: "a".repeat(40),
    dirty: false,
    clean: true,
    merged: true,
    worktree: {
      path: "/work/worktrees/156",
      mainPath: "/work/demo",
      mainBranch: "refs/heads/develop",
      changes: "",
    },
  });
  expect(plan.kind).toBe("run");
  if (plan.kind !== "run") return;
  const commands = toCommands(
    plan.steps,
    { kind: "docker", container: "omi-demo", repoDir: "/work/demo" },
    "/unused",
  );
  expect(commands[0]?.args.at(-1)).toContain("worktree remove --force -- /work/worktrees/156");
});
