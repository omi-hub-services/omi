import { expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDockerWorker } from "../../../src/infrastructure/processes/docker-worker.js";

it("stops its owned worker on pipe EOF and refuses known secrets in logs", async () => {
  const module = await import("../../../src/infrastructure/processes/docker-worker.js").catch(
    () => undefined,
  );
  expect(module?.runDockerWorker, "Docker owner supervisor is missing").toBeTypeOf("function");
  if (module === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "omi-docker-worker-"));
  const owner = new PassThrough();
  try {
    const run = await module.runDockerWorker(
      {
        task: "156",
        profile: "test",
        kind: "claude",
        model: "test",
        effort: "low",
        resume: null,
        packet: "implement-1-test",
      },
      {
        cwd: dir,
        runsDir: dir,
        owner,
        prompt: "fake prompt",
        env: { GH_TOKEN: "fake-sensitive-value", PATH: process.env.PATH ?? "" },
        invocation: {
          executable: process.execPath,
          args: ["-e", "console.log(process.env.GH_TOKEN); setInterval(() => {}, 1000)"],
        },
      },
    );
    owner.end();
    const result = await run.result;
    expect(result.ownerGone?.reason).toBe("channel-closed");
    for (const file of await readdir(dir))
      expect(await readFile(join(dir, file), "utf8")).not.toContain("fake-sensitive-value");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not pass runtime relay slots to its native worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omi-docker-env-"));
  const owner = new PassThrough();
  try {
    const record = join(directory, "child-env.json");
    const run = await runDockerWorker(
      {
        task: "156",
        profile: "test",
        kind: "claude",
        model: "test",
        effort: "low",
        resume: null,
        packet: "env-1-test",
      },
      {
        cwd: directory,
        runsDir: directory,
        owner,
        prompt: "fake",
        env: {
          PATH: process.env.PATH ?? "",
          OMI_DOCKER_PROFILE_TOKEN_1: "fake-other-profile",
          OMI_DOCKER_SETTINGS: "metadata",
        },
        invocation: {
          executable: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({profileSlot:Object.hasOwn(process.env,'OMI_DOCKER_PROFILE_TOKEN_1'),metadata:Object.hasOwn(process.env,'OMI_DOCKER_SETTINGS')}));`,
          ],
        },
      },
    );
    await run.result;
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
      profileSlot: false,
      metadata: false,
    });
  } finally {
    owner.end();
    await rm(directory, { recursive: true, force: true });
  }
});
