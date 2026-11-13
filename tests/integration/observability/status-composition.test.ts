import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { expect, it } from "vitest";
import { createOverviewCommands } from "../../../src/bootstrap/container.ts";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.ts";
import { baseline, project } from "../../fixtures/github/project-mapping.ts";
import { FakeGithubBoard } from "../../contract/github/fake-github-board.ts";

it("reads status beside a stopped runtime with only project config and existing state, without writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omi-status-composition-"));
  const squad = join(directory, ".omi-squad");
  mkdirSync(join(squad, "config"), { recursive: true });
  mkdirSync(join(squad, "local/state"), { recursive: true });
  writeFileSync(join(squad, "config/project.yaml"), stringify(baseline));
  const database = openStateDatabase(join(squad, "local/state/state.sqlite"));
  try {
    applyMigrations(database, loadMigrations(resolve("migrations")));
    const remote = new FakeGithubBoard(project);
    const commands = createOverviewCommands({
      send: (request) =>
        request.path.includes("/pulls?")
          ? Promise.resolve({ status: 200, headers: {}, body: "[]" })
          : remote.send(request),
    });
    expect(await commands.status(directory)).toMatchObject({
      statuses: [],
      pulls: [],
      workers: [],
      next: null,
      quota: null,
    });
    expect(remote.writes).toEqual([]);
    expect(database.prepare("SELECT count(*) AS count FROM workflow_runs").get()).toEqual({
      count: 0,
    });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
