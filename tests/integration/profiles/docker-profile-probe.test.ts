import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createProfileUseCases } from "../../../src/bootstrap/container.js";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.js";
import {
  applyMigrations,
  loadMigrations,
} from "../../../src/infrastructure/persistence/sqlite/migration-runner.js";
import { parseOmiSetting } from "../../../src/application/contracts/omisetting.js";

it("probes the selected runtime profile with its relayed credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omi-docker-probe-"));
  const database = openStateDatabase(join(directory, "state.sqlite"));
  try {
    applyMigrations(database, loadMigrations(resolve("migrations")));
    const home = join(directory, "profile");
    await mkdir(home);
    const record = join(directory, "invocation.json");
    await writeFile(
      join(directory, "claude"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({token:process.env.CLAUDE_CODE_OAUTH_TOKEN,github:process.env.GH_TOKEN}));\nconsole.log('2.1.322 (Claude Code)');\n`,
    );
    await chmod(join(directory, "claude"), 0o755);
    vi.stubEnv("PATH", directory);
    const settings = parseOmiSetting({
      version: 1,
      github: { token: "fake-github-probe", gitUser: { name: "bot", email: "bot@example.com" } },
      profiles: [
        { id: "selected", tool: "claude", auth: { type: "token", token: "fake-selected-probe" } },
      ],
      docker: {},
    });
    const profiles = createProfileUseCases(database, () => true, settings);
    expect(
      profiles.registerProfile({
        profileId: "selected",
        tool: "claude-code",
        credentialRef: home,
        accountGroupId: "test",
        modelAllowlist: ["test"],
      }).ok,
    ).toBe(true);
    await profiles.probeProfile({ profileId: "selected" });
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
      token: "fake-selected-probe",
      github: "fake-github-probe",
    });
  } finally {
    vi.unstubAllEnvs();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
