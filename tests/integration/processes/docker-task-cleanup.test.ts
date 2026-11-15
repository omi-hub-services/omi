import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cleanupDockerTask } from "../../../src/infrastructure/processes/docker-task-cleanup.js";

it("refuses a reused process identity and preserves task scratch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omi-docker-cleanup-"));
  try {
    await writeFile(
      join(directory, "omi-156-process-test.json"),
      JSON.stringify({ pid: process.pid, startIdentity: "different-boot:0" }),
    );
    await mkdir(join(directory, "omi-156-tmp-test"));
    await writeFile(join(directory, "omi-156-tmp-test/work"), "kept");
    await expect(cleanupDockerTask("156", directory)).rejects.toThrow("ownership changed");
    expect(await readFile(join(directory, "omi-156-tmp-test/work"), "utf8")).toBe("kept");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("removes only the completed task's scratch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omi-docker-cleanup-"));
  try {
    for (const task of ["156", "157"]) {
      await mkdir(join(directory, `omi-${task}-tmp-test`));
      await writeFile(join(directory, `omi-${task}-tmp-test/work`), "kept");
    }
    await cleanupDockerTask("156", directory);
    await expect(readFile(join(directory, "omi-156-tmp-test/work"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(directory, "omi-157-tmp-test/work"), "utf8")).toBe("kept");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
