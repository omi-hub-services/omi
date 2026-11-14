import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRuntimeIpcServer } from "../../../src/bootstrap/container.ts";
import { deliverRun } from "../../../src/application/use-cases/delivery/deliver-run.ts";
import { prepareRunPr } from "../../../src/application/use-cases/delivery/prepare-run-pr.ts";
import { commandSchema, type Command } from "../../../src/application/contracts/command.ts";
import { createCommandDispatcher } from "../../../src/interfaces/ipc/command-dispatcher.ts";
import { sendCommand } from "../../../src/interfaces/ipc/ipc-client.ts";
import { createGithubPrDelivery } from "../../../src/infrastructure/github/github-pr-delivery.ts";
import { createGithubRestClient } from "../../../src/infrastructure/github/github-rest-client.ts";
import { sandbox, request, HEAD } from "../../e2e/merge-task-pr-sandbox.ts";
import { runPreparation } from "../../unit/application/use-cases/delivery/prepare-run-pr-fakes.ts";

it.each(["dispatcher", "socket"])(
  "prepares and delivers a run PR through IPC %s",
  async (transport) => {
    const dir = mkdtempSync(join(tmpdir(), "omi-prepare-ipc-"));
    const h = sandbox({ mapped: false });
    h.github.pulls.splice(0);
    const run = runPreparation();
    const plan = { ...request, templateHash: "a".repeat(64) };
    const attempt = {
      ...run.attempt,
      workspace: {
        ...run.attempt.workspace,
        taskId: request.taskId,
        branch: "task/omi-023-merge-gates",
      },
    };
    const client = createGithubRestClient({
      transport: h.github,
      now: h.deps.now,
      random: () => 0,
      sleep: () => Promise.resolve(),
    });
    const deps = {
      ...run.deps,
      plans: { forRun: () => plan },
      attempts: { latestForStep: () => attempt },
      workspaces: {
        inspect: () => ({
          ok: true as const,
          value: {
            path: attempt.workspace.path,
            branch: attempt.workspace.branch,
            headSha: HEAD,
            dirty: false,
            hasIgnoredFiles: false,
          },
        }),
      },
      prepare: { ...h.deps, reader: createGithubPrDelivery(client) },
    };
    const socketPath = join(dir, "runtime.sock");
    const useCases = {
      prepareRunPr: (input: unknown) => prepareRunPr(deps, input),
      deliverRun: (input: unknown) =>
        deliverRun(
          {
            runs: deps.runs,
            plans: deps.plans,
            merge: h.deps,
            session: { commit: () => ({ ok: true as const, newVersion: 2, eventSequence: 1 }) },
            nextId: () => "done",
          },
          input,
        ),
    };
    const server = createRuntimeIpcServer({
      socketPath,
      identity: { runtimeVersion: "0", startedAt: "2026-11-14T00:00:00.000Z" },
      runs: useCases,
    });
    const handler = createCommandDispatcher({
      ...useCases,
      inspectRuntime: () => ({
        state: "ready",
        schemaVersion: 1,
        runtimeVersion: "0",
        startedAt: "2026-11-14T00:00:00.000Z",
      }),
    });
    const send = (command: Command) =>
      transport === "socket"
        ? sendCommand({ socketPath, command })
        : handler(commandSchema.parse(command));
    try {
      if (transport === "socket") await server.start();
      const deliver = (prNumber: number) =>
        send({
          schemaVersion: 1,
          command: "deliver",
          runId: "r",
          prNumber,
          reviewedHeadSha: HEAD,
          requiredChecks: ["ci"],
          minimumNativeApprovals: 0,
        });
      expect(await deliver(128)).toMatchObject({
        ok: false,
        error: { code: "COMMAND_REFUSED", message: "MAPPING_MISMATCH" },
      });
      const command: Command = {
        schemaVersion: 1,
        command: "prepare-pr",
        runId: "r",
        title: "Task",
        evidence: ["unit", "IPC integration"],
      };
      const prepared = await send(command);
      expect(prepared).toMatchObject({ ok: true, result: { status: "verified" } });
      expect(await send(command)).toEqual(prepared);
      expect(h.github.pulls).toHaveLength(1);
      expect(h.github.comments).toHaveLength(1);
      const mapping = h.deps.mappings.get(request.projectId, request.taskId);
      expect(mapping).toBeDefined();
      if (mapping === undefined) throw new Error("MISSING_MAPPING");
      expect(await deliver(mapping.prNumber + 1)).toMatchObject({
        ok: false,
        error: { code: "COMMAND_REFUSED", message: "MAPPING_MISMATCH" },
      });
      const pull = h.github.pulls[0];
      if (pull === undefined) throw new Error("MISSING_PULL");
      pull.headSha = HEAD;
      expect(await deliver(mapping.prNumber)).toMatchObject({
        ok: true,
        result: { status: "done" },
      });
      expect(h.task.status).toBe("done");
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
