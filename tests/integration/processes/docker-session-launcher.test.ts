import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { expect, it } from "vitest";
import {
  launchWindowsSession,
  type SessionSpawn,
} from "../../../src/infrastructure/processes/windows-session-launcher.js";

function fakeSession() {
  const calls: { file: string; args: readonly string[] }[] = [];
  const environments: SpawnOptions["env"][] = [];
  const spawn: SessionSpawn = (file, args, options) => {
    environments.push(options.env);
    calls.push({ file, args });
    const runtime = calls.length === 1;
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: Writable };
    child.stdout = new PassThrough();
    child.stdin = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
      final(done) {
        queueMicrotask(() => child.emit("close", 0, null));
        done();
      },
    });
    queueMicrotask(() => {
      if (runtime) child.stdout.write("ready\n");
      else child.emit("close", 0, null);
    });
    return child as unknown as ChildProcess;
  };
  return { calls, environments, spawn };
}

it("holds the runtime owner pipe through Docker exec", async () => {
  const { calls, spawn } = fakeSession();
  const result = await launchWindowsSession(
    { projectDir: "/work/demo", runtimePath: "/opt/runtime.js", coordinator: "claude" },
    { spawn, docker: { container: "omi-demo", repoDir: "/work/demo" } },
  );
  expect(result.runtimeStopped).toBe(true);
  expect(calls[0]).toEqual({
    file: "docker",
    args: [
      "exec",
      "-i",
      "-w",
      "/work/demo",
      "omi-demo",
      "node",
      "/work/demo/.omi/tool/node_modules/omi-squad/dist/bootstrap/runtime.js",
      "/work/demo",
    ],
  });
});

it("forwards the relay to Docker without adding credentials to the native Coordinator", async () => {
  const { calls, environments, spawn } = fakeSession();
  const runtimeEnv = {
    GH_TOKEN: "fake-runtime-github",
    OMI_DOCKER_PROFILE_TOKEN_0: "fake-runtime-profile",
    OMI_DOCKER_SETTINGS: "metadata",
  };
  await launchWindowsSession(
    { projectDir: "/work/demo", runtimePath: "/opt/runtime.js", coordinator: "claude" },
    { spawn, docker: { container: "omi-demo", repoDir: "/work/demo" }, runtimeEnv },
  );
  expect(calls[0]?.args.slice(0, 8)).toEqual([
    "exec",
    "-i",
    "-e",
    "GH_TOKEN",
    "-e",
    "OMI_DOCKER_PROFILE_TOKEN_0",
    "-e",
    "OMI_DOCKER_SETTINGS",
  ]);
  expect(calls[0]?.args.join(" ")).not.toContain(runtimeEnv.GH_TOKEN);
  expect(calls[0]?.args.join(" ")).not.toContain(runtimeEnv.OMI_DOCKER_PROFILE_TOKEN_0);
  expect(environments[0]?.GH_TOKEN).toBe(runtimeEnv.GH_TOKEN);
  expect(environments[1]).toBeUndefined();
});
