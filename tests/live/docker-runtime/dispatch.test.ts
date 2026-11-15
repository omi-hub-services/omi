import { expect, it } from "vitest";
import { createDockerFixture, dispatchFakeTask, liveDocker } from "./docker-fixture.ts";
import { dockerRuntimeEnvironment } from "../../../src/infrastructure/config/docker-runtime-environment.js";
import { parseOmiSetting } from "../../../src/application/contracts/omisetting.js";

it.skipIf(!liveDocker)(
  "AC-2 dispatches a task step without persisting tokens",
  async () => {
    const fixture = await createDockerFixture();
    try {
      const code = await dispatchFakeTask(fixture);
      expect(code).toBe(0);
      const env = dockerRuntimeEnvironment(parseOmiSetting(fixture.settings));
      const relay = await fixture.docker(
        [
          "exec",
          ...Object.keys(env).flatMap((name) => ["-e", name]),
          fixture.target.container,
          "node",
          "--input-type=module",
          "-e",
          "import { loadOmiSetting } from '/work/framework/dist/infrastructure/config/load-omisetting.js'; const settings = await loadOmiSetting('/missing-project'); if (settings.github.token !== process.env.GH_TOKEN || settings.profiles[0].auth.token !== process.env.OMI_DOCKER_PROFILE_TOKEN_0) process.exit(1); console.log('runtime-relay-ok');",
        ],
        { env },
      );
      expect(relay.trim()).toBe("runtime-relay-ok");
      const inspect = await fixture.docker(["inspect", fixture.target.container]);
      const logs = await fixture.docker([
        "exec",
        fixture.target.container,
        "bash",
        "-lc",
        "cat $HOME/omi-runs/*.jsonl $HOME/omi-runs/*.err",
      ]);
      expect(logs).toContain("fake task step completed");
      for (const secret of [
        fixture.settings.github.token,
        fixture.settings.profiles[0]?.auth.token,
      ]) {
        expect(inspect).not.toContain(secret);
        expect(logs).not.toContain(secret);
      }
    } finally {
      await fixture.stop();
    }
  },
  600_000,
);
