import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runSessionRuntime } from "../../../src/bootstrap/runtime.ts";
import type { RuntimeCompositionOptions } from "../../../src/bootstrap/container.ts";
import type { AgentExecutor } from "../../../src/application/ports/agent-executor.ts";
import type {
  ExecutionHandle,
  ExecutionRequest,
  ExecutionResult,
} from "../../../src/application/contracts/agent-execution.ts";
import type { SupervisedProcess } from "../../../src/infrastructure/processes/supervised-process.ts";
import { FakeGithub } from "../../contract/github/fake-github.ts";
import { operationMarker } from "../../../src/domain/delivery/operation-marker.ts";

const project = process.argv[2] ?? "";
const mode = process.argv[3] ?? "good";
const stateFile = join(project, "..", "fake-github.json");
const repo = "acme/app";
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const base = git(project, "rev-parse", "HEAD");
const remote = new FakeGithub();
const body = readFileSync(join(project, "..", "issue.md"), "utf8");
remote.issues.push({
  repo,
  number: 142,
  title: "Runtime composition",
  body,
  createdAt: new Date().toISOString(),
});
remote.pulls.push({
  repo,
  number: 143,
  title: "Runtime",
  body: `Issue: #142\n${operationMarker(`create-pr:${repo}:task-142:task/omi-070-omi-070:develop`)}`,
  head: "task/omi-070-omi-070",
  base: "develop",
  headSha: base,
  author: "worker",
  createdAt: new Date().toISOString(),
});
remote.branches.set(`${repo}:develop`, base);
remote.commits.set(base, { repo, parents: [] });
remote.rules.set(`${repo}:develop`, [
  { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } },
]);

const executors: RuntimeCompositionOptions["executors"] = (ports) => {
  const make = (executor: "claude-code" | "codex"): AgentExecutor => {
    const workers = new Map<string, { request: ExecutionRequest; worker: SupervisedProcess }>();
    return {
      executor,
      probe: () => Promise.reject(new Error("NO_LIVE_PROBES")),
      async start(request) {
        const worker = await ports.startProcess({
          executable: process.execPath,
          args: ["-e", `setTimeout(() => {}, ${mode === "slow" ? "2000" : "250"})`],
          cwd: request.workspace,
          env: {},
          stdin: "",
          onStdoutLine: () => undefined,
          timeoutMs: 5000,
          graceMs: 100,
          maxStdoutChars: 1000,
          maxLineChars: 1000,
          maxStderrChars: 1000,
        });
        ports.onWorkerStarted(request.attemptId, worker);
        workers.set(request.attemptId, { request, worker });
        return { executionId: request.attemptId, attemptId: request.attemptId, executor };
      },
      async *events() {
        /* no fake progress events */
      },
      async cancel(handle) {
        const run = workers.get(handle.attemptId);
        run?.worker.cancel();
        await run?.worker.exit;
      },
      async collectResult(handle: ExecutionHandle): Promise<ExecutionResult> {
        const run = workers.get(handle.attemptId);
        const attempt = ports.attempts.get(handle.attemptId);
        if (run === undefined || attempt === undefined) throw new Error("UNKNOWN_ATTEMPT");
        const exit = await run.worker.exit;
        const limit = mode === "waiting" || (mode === "failover" && attempt.attemptNumber === 1);
        const quality = mode === "quality" && attempt.attemptNumber === 1;
        if (!limit && !quality && attempt.stepId === "implement" && !exit.cancelRequested) {
          writeFileSync(join(run.request.workspace, "result.txt"), "implemented\n");
          git(run.request.workspace, "add", "result.txt");
          git(run.request.workspace, "commit", "-m", "fixture implementation");
        }
        const head = git(run.request.workspace, "rev-parse", "HEAD");
        const pull = remote.pulls[0];
        if (pull !== undefined) pull.headSha = head;
        remote.commits.set(head, { repo, parents: head === base ? [] : [base] });
        remote.checkRuns.push({
          repo,
          id: remote.checkRuns.length + 1,
          name: "ci",
          headSha: head,
          status: "completed",
          conclusion: "success",
        });
        const report = ports.artifacts.write({
          id: randomUUID(),
          path: `attempts/${attempt.id}/report.md`,
          bytes: new TextEncoder().encode("AC-1: met — runtime fixture verified"),
          classification: "report",
          createdAt: new Date().toISOString(),
        });
        return {
          ...handle,
          outcome: limit ? "usage-limit" : exit.cancelRequested ? "cancelled" : "succeeded",
          exitCode: exit.exitCode,
          signal: exit.signal,
          durationMs: exit.durationMs,
          model: { requested: run.request.model },
          effort: { requested: run.request.effort },
          authMode: "subscription",
          toolsUsed: [],
          eventCount: 0,
          unparsedLines: 0,
          escalated: exit.escalated,
          leftoverProcessesKilled: exit.leftoverProcessesKilled,
          ...(limit
            ? {}
            : {
                finalMessage: JSON.stringify({
                  schemaVersion: 1,
                  runId: attempt.runId,
                  stepId: attempt.stepId,
                  attemptId: attempt.id,
                  status: quality ? "failed" : "succeeded",
                  summary: "AC-1: met — runtime fixture verified",
                  artifacts: [report],
                  revision: { headSha: head, baseSha: base },
                  checks: [],
                  findings: [],
                }),
              }),
        };
      },
    };
  };
  return { "claude-code": make("claude-code"), codex: make("codex") };
};
try {
  await runSessionRuntime(project, {
    executors,
    transport: {
      async send(request) {
        const response = await remote.send(request);
        writeFileSync(
          stateFile,
          JSON.stringify({ issues: remote.issues, pulls: remote.pulls, requests: remote.requests }),
        );
        return response;
      },
    },
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : "runtime fixture failed"}\n`);
  process.exitCode = 1;
}
