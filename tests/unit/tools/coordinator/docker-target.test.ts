import { expect, it } from "vitest";
import { wslCommand } from "../../../../tools/coordinator/process-runner.ts";

it("routes Docker worker reads through exec without a local cwd", () => {
  const command = wslCommand("git status", {
    kind: "docker",
    container: "omi-demo",
    repoDir: "/work/demo",
  });
  expect(command.file).toBe("docker");
  expect(command.args).toEqual([
    "exec",
    "-i",
    "-w",
    "/work/demo",
    "omi-demo",
    "bash",
    "-lc",
    "git status",
  ]);
  expect(command.cwd).toBeUndefined();
});
