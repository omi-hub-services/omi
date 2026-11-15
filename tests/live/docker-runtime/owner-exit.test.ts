import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDockerFixture, liveDocker, writeFixtureFile } from "./docker-fixture.ts";

it.skipIf(!liveDocker)(
  "AC-3 Docker exec EOF stops the owned group",
  async () => {
    const fixture = await createDockerFixture();
    try {
      const script = `import { writeFile } from 'node:fs/promises';
import { runDockerWorker } from '/work/framework/dist/infrastructure/processes/docker-worker.js';
const run = await runDockerWorker({task:'156',profile:'test',kind:'claude',model:'test',effort:'low',resume:null,packet:'owner-1-test'}, {cwd:process.cwd(),runsDir:'/work/owner-logs',owner:process.stdin,prompt:'fake',env:{PATH:process.env.PATH},invocation:{executable:'node',args:['-e','setInterval(() => {}, 1000)']}});
console.log('ready:' + run.worker.pid);
const result = await run.result; await writeFile('/work/owner-result.json', JSON.stringify({reason:result.ownerGone?.reason,pid:run.worker.pid}));
`;
      await writeFixtureFile(
        fixture.target.container,
        fixture.context,
        join(fixture.root, "owner.mjs"),
        "/work/owner.mjs",
        script,
      );
      const launcher = join(fixture.root, "launcher.mjs");
      await writeFile(
        launcher,
        `import { spawn } from 'node:child_process'; const child = spawn('docker', ${JSON.stringify(["--context", "CONTEXT_PLACEHOLDER", "exec", "-i", "CONTAINER_PLACEHOLDER", "node", "/work/owner.mjs"])}, {stdio:['pipe','pipe','inherit']}); child.stdout.pipe(process.stdout);`
          .replace("CONTEXT_PLACEHOLDER", fixture.context)
          .replace("CONTAINER_PLACEHOLDER", fixture.target.container),
      );
      const child = spawn(process.execPath, [launcher], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      try {
        await vi.waitFor(
          () => {
            expect(output).toMatch(/ready:\d+/);
          },
          { timeout: 10000 },
        );
        child.kill("SIGKILL");
        await vi.waitFor(
          async () => {
            const result = await fixture.docker([
              "exec",
              fixture.target.container,
              "cat",
              "/work/owner-result.json",
            ]);
            expect(JSON.parse(result)).toMatchObject({ reason: "channel-closed" });
          },
          { timeout: 10000 },
        );
      } finally {
        child.kill("SIGKILL");
      }
      const pid = /ready:(\d+)/.exec(output)?.[1];
      const alive = await fixture.run({
        file: "docker",
        args: ["exec", fixture.target.container, "test", "-e", `/proc/${pid ?? "missing"}`],
      });
      expect(alive.code).toBe(1);
    } finally {
      await fixture.stop();
    }
  },
  600_000,
);
