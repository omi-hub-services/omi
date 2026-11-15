import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { createProfileLogin } from "../../../src/infrastructure/profiles/login-profile.ts";
import { createCliEnvironment } from "../../../src/bootstrap/container.ts";
import { runCli } from "../../../src/interfaces/cli/commands/create-program.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("logs a Codex profile in with a fake binary and keeps auth out of settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omi-profile-login-"));
  dirs.push(dir);
  await mkdir(join(dir, ".omi"));
  const settings = JSON.stringify({
    version: 1,
    github: { token: "fake-github", gitUser: { name: "bot", email: "bot@example.com" } },
    profiles: [{ id: "codex-main", tool: "codex", auth: { type: "login" } }],
  });
  await writeFile(join(dir, ".omi/omisetting.local.json"), settings);
  const binary = join(dir, "fake-codex");
  await writeFile(
    binary,
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.CODEX_HOME + '/auth.json', JSON.stringify({ auth_mode: 'chatgpt', fake: true }));\n`,
  );
  await chmod(binary, 0o755);
  let output = "";
  const environment = createCliEnvironment({
    socketPath: join(dir, "socket"),
    stdout: (text) => {
      output += text;
    },
    stderr: (text) => {
      output += text;
    },
  });
  const result = await runCli(["profile", "login", "codex-main", "--project", dir], {
    ...environment,
    profileLogin: createProfileLogin({ executable: binary, home: dir }),
  });
  expect(result, output).toBe(0);
  expect(await readFile(join(dir, ".omi/omisetting.local.json"), "utf8")).toBe(settings);
  expect(
    JSON.parse(await readFile(join(dir, ".codex-profiles/codex-main/auth.json"), "utf8")),
  ).toEqual({ auth_mode: "chatgpt", fake: true });
});

it("reports malformed JSON without echoing credential bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omi-settings-invalid-"));
  dirs.push(dir);
  await mkdir(join(dir, ".omi"));
  await writeFile(
    join(dir, ".omi/omisetting.local.json"),
    '{"github":{"token":"FAKE_PRIVATE_VALUE" BROKEN',
  );
  const { loadOmiSetting } = await import("../../../src/infrastructure/config/load-omisetting.ts");
  await expect(loadOmiSetting(dir)).rejects.toThrow("omisetting.local.json: invalid JSON");
  try {
    await loadOmiSetting(dir);
  } catch (error) {
    expect(String(error)).not.toContain("FAKE_PRIVATE_VALUE");
  }
});

it("rejects token profiles before spawning a native login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omi-token-login-"));
  dirs.push(dir);
  await mkdir(join(dir, ".omi"));
  await writeFile(
    join(dir, ".omi/omisetting.local.json"),
    JSON.stringify({
      version: 1,
      github: { token: "fake-github", gitUser: { name: "bot", email: "bot@example.com" } },
      profiles: [
        { id: "claude-main", tool: "claude", auth: { type: "token", token: "fake-claude" } },
      ],
    }),
  );
  await expect(
    createProfileLogin({ executable: "must-not-run", home: dir })({
      projectDir: dir,
      profileId: "claude-main",
    }),
  ).rejects.toThrow("PROFILE_LOGIN_REQUIRES_CODEX_LOGIN_PROFILE");
});
