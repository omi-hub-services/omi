import { expect, it, vi } from "vitest";
import { wslCommand, runChecked } from "../../../tools/coordinator/process-runner.ts";
import { planCleanup, toCommands } from "../../../tools/coordinator/flow-plans.ts";
import { probeCleanupWsl } from "../../../tools/coordinator/git-probe.ts";
import {
  planRetention,
  parseRunsListing,
  retentionScript,
  RUNS_LISTING,
} from "../../../tools/coordinator/runs-retention.ts";
import { RUNS_RETENTION } from "../../../tools/coordinator/coordinator-settings.ts";
import { createDockerFixture, dispatchFakeTask, liveDocker } from "./docker-fixture.ts";

it.skipIf(!liveDocker)(
  "AC-4 five task cleanups leave no extra worktrees, processes, images or scratch",
  async () => {
    const fixture = await createDockerFixture();
    const run = (payload: string) => runChecked(fixture.run, wslCommand(payload, fixture.target));
    try {
      await run("git remote add origin .; git fetch origin");
      const snapshot = async () => ({
        trees: await run("git worktree list --porcelain"),
        processes: await run("ps -eo comm= | sort"),
        images: await fixture.docker(["image", "ls", "--quiet"]),
        scratch: await run("find /work -type d -name 'omi-*-tmp-*'"),
      });
      const before = await snapshot();
      for (const task of ["151", "152", "153", "154", "155"]) {
        const branch = `task/omi-${task}-live`;
        const path = `/work/worktree-${task}`;
        await run(
          `git worktree add -b ${branch} ${path}; mkdir -p ${path}/node_modules $HOME/omi-runs/omi-${task}-tmp-live; touch ${path}/node_modules/fixture; printf fake > $HOME/omi-runs/omi-${task}-test-20261115-120000.jsonl`,
        );
        expect(await dispatchFakeTask(fixture, task, path)).toBe(0);
        const cleanup = await probeCleanupWsl(fixture.run, fixture.target, branch, {});
        const plan = planCleanup(branch, "wsl", cleanup.state);
        expect(plan.kind).toBe("run");
        if (plan.kind !== "run") throw new Error("Cleanup refused");
        await run(
          `node .omi/tool/node_modules/omi-squad/dist/infrastructure/processes/docker-task-cleanup.js ${task}`,
        );
        for (const command of toCommands(plan.steps, fixture.target, fixture.root))
          await runChecked(fixture.run, command);
        const listing = parseRunsListing(await run(RUNS_LISTING));
        const script = retentionScript(
          planRetention(listing, new Set([task]), RUNS_RETENTION, true),
        );
        if (script !== null) await run(script);
        expect(
          await run(
            `test ! -e ${path}; test -f $HOME/omi-runs/archive/omi-${task}-test-20261115-120000.jsonl.gz`,
          ),
        ).toBe("");
      }
      await vi.waitFor(
        async () => {
          expect(await snapshot()).toEqual(before);
        },
        { timeout: 5000 },
      );
    } finally {
      await fixture.stop();
    }
  },
  600_000,
);
