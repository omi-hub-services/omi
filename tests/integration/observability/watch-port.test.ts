import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as watch from "../../../src/infrastructure/observability/watch-server.js";

it("uses the published project port as the watch default and preserves explicit ports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omi-watch-port-"));
  try {
    expect(watch.configuredWatchPort).toBeTypeOf("function");
    expect(await watch.configuredWatchPort(dir)).toBe(4381);
    await mkdir(join(dir, ".omi"));
    await writeFile(
      join(dir, ".omi", "omisetting.local.json"),
      JSON.stringify({
        version: 1,
        github: { token: "fake", gitUser: { name: "bot", email: "bot@example.com" } },
        profiles: [{ id: "login", tool: "codex", auth: { type: "login" } }],
        docker: { watchPort: 5381 },
      }),
    );
    expect(await watch.configuredWatchPort(dir)).toBe(5381);
    expect(await watch.configuredWatchPort(dir, 6381)).toBe(6381);
    expect(await watch.configuredWatchPort(dir, 0)).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
