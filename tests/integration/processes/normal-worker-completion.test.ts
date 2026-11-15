import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { startSupervisedProcess } from "../../../src/infrastructure/processes/supervised-process.js";
import { createProcessRunner } from "../../../tools/coordinator/process-runner.ts";

it.each(["inherit", "ignore"])(
  "finishes the owned group after normal exit (descendant pipes: %s)",
  async (pipes) => {
    const directory = await mkdtemp(join(tmpdir(), "omi-normal-group-"));
    const worker = await startSupervisedProcess({
      executable: process.execPath,
      args: [
        "-e",
        `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: ${pipes === "inherit" ? "['ignore', 1, 2]" : "'ignore'"}}); child.unref();`,
      ],
      cwd: directory,
      env: {},
      stdin: "",
      onStdoutLine: () => undefined,
      timeoutMs: 10000,
      graceMs: 100,
      maxStdoutChars: 1000,
      maxLineChars: 1000,
      maxStderrChars: 1000,
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        worker.exit.then((result) => ({ finished: true as const, result })),
        new Promise<{ finished: false }>((done) => {
          timer = setTimeout(() => {
            done({ finished: false });
          }, 750);
        }),
      ]);
      expect(
        outcome.finished,
        "normal exit must stop descendants before waiting for pipe close",
      ).toBe(true);
      if (outcome.finished)
        expect(outcome.result).toMatchObject({
          exitCode: 0,
          leftoverProcessesKilled: true,
          timedOut: false,
          escalated: false,
        });
    } finally {
      clearTimeout(timer);
      try {
        process.kill(-worker.pid, "SIGKILL");
      } catch {
        /* already stopped */
      }
      await worker.exit;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  "returns to the host with the owner pipe still open (orphan: %s)",
  async (orphan) => {
    const directory = await mkdtemp(join(tmpdir(), "omi-normal-owner-"));
    try {
      const marker = join(directory, "finished.json");
      const script = join(directory, "entry.mjs");
      const invocation = orphan
        ? "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); child.unref();"
        : "process.exitCode = 0;";
      await writeFile(
        script,
        `import { writeFile } from 'node:fs/promises';
import { runDockerWorker } from ${JSON.stringify(pathToFileURL(resolve("src/infrastructure/processes/docker-worker.ts")).href)};
const directory = ${JSON.stringify(directory)};
const run = await runDockerWorker({task:'156',profile:'test',kind:'claude',model:'test',effort:'low',resume:null,packet:'normal-1-test'}, {cwd:directory,runsDir:directory,owner:process.stdin,prompt:'fake',env:{},invocation:{executable:process.execPath,args:['-e',${JSON.stringify(invocation)}]}});
const result = await run.result;
await writeFile(${JSON.stringify(marker)}, JSON.stringify({exitCode:result.workerExit.exitCode, orphanStopped:result.workerExit.leftoverProcessesKilled,ownerGone:result.ownerGone,signal:result.workerExit.signal}));
process.stdout.write('exit=0\\n');
`,
      );
      const result = await createProcessRunner()({
        file: process.execPath,
        args: ["--import", resolve("tools/register-ts-imports.ts"), script],
        keepStdinOpen: true,
        input: "heartbeat\n",
        timeoutMs: 2000,
      });
      const completed: unknown = JSON.parse(await readFile(marker, "utf8"));
      expect(completed).toEqual({
        exitCode: 0,
        orphanStopped: orphan,
        ownerGone: null,
        signal: null,
      });
      expect(
        result.code,
        "finished worker must release its owner pipe without waiting for EOF",
      ).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
