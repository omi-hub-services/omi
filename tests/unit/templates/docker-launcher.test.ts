import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { parseOmiSetting } from "../../../src/application/contracts/omisetting.ts";
import { dockerRuntimeEnvironment } from "../../../src/infrastructure/config/docker-runtime-environment.js";

const requireNative = createRequire(import.meta.url);
const schema: unknown = JSON.parse(readFileSync("schemas/omisetting.schema.json", "utf8"));
export const fixtureSettings = {
  version: 1,
  github: { token: "fake-github-relay", gitUser: { name: "bot", email: "bot@example.com" } },
  profiles: [
    { id: "claude-main", tool: "claude", auth: { type: "token", token: "fake-claude-relay" } },
    { id: "codex-main", tool: "codex", auth: { type: "login" } },
  ],
  docker: { container: "omi-demo" },
};

export function launcher(settings: unknown = fixtureSettings) {
  const calls: { file: string; args: string[]; options: { env: Record<string, string> } }[] = [];
  const diagnostics: string[] = [];
  const module = { exports: {} };
  const process = {
    argv: ["node", "omi.cjs", "status"],
    env: { PATH: "/bin" },
    stderr: { write: (text: string) => diagnostics.push(text) },
    exitCode: 0,
  };
  const require = (name: string): unknown => {
    if (name === "node:child_process")
      return {
        spawnSync: (file: string, args: string[], options: { env: Record<string, string> }) => {
          calls.push({ file, args, options });
          return { status: 0 };
        },
      };
    if (name === "node:fs")
      return {
        existsSync: () => true,
        lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }),
        readFileSync: () => JSON.stringify(settings),
      };
    if (name.endsWith("omisetting.schema.json")) return schema;
    return requireNative(name) as unknown;
  };
  runInNewContext(readFileSync("templates/bridges/omi.cjs", "utf8"), {
    require,
    module,
    process,
    Buffer,
    __dirname: resolve("/tmp/demo/.omi/bin"),
  });
  return {
    bridge: module.exports as {
      main: () => Promise<void>;
      validateSettings: (value: unknown, schema: unknown) => typeof fixtureSettings;
      dockerEnvironment: (value: unknown, profiles: boolean) => Record<string, string>;
    },
    calls,
    diagnostics,
  };
}

it("relays only required environment names to the fake Docker executable", async () => {
  const { bridge, calls } = launcher();
  expect(bridge.main, "standalone Docker launcher entrypoint").toBeTypeOf("function");
  await bridge.main();
  expect(calls[0]?.file).toBe("docker");
  expect(calls[0]?.args).toEqual([
    "exec",
    "-i",
    "-e",
    "GH_TOKEN",
    "-w",
    "/work/demo",
    "omi-demo",
    "/work/demo/.omi/bin/omi",
    "status",
  ]);
  expect(calls[0]?.options.env.GH_TOKEN).toBe(fixtureSettings.github.token);
  expect(calls[0]?.args.join(" ")).not.toContain(fixtureSettings.github.token);
  expect(Object.values(calls[0]?.options.env ?? {})).not.toContain("fake-claude-relay");
});

it("projects runtime tokens into environment slots without placing values in metadata", () => {
  const { bridge } = launcher();
  expect(bridge.dockerEnvironment, "runtime environment relay").toBeTypeOf("function");
  const env = bridge.dockerEnvironment(fixtureSettings, true);
  expect(env.OMI_DOCKER_PROFILE_TOKEN_0).toBe("fake-claude-relay");
  expect(env.OMI_DOCKER_PROFILE_TOKEN_1).toBeUndefined();
  expect(env.OMI_DOCKER_SETTINGS).not.toContain("fake-claude-relay");
  expect(env.OMI_DOCKER_SETTINGS).not.toContain(fixtureSettings.github.token);
});

it("rejects invalid settings by field path without echoing values", () => {
  const { bridge } = launcher();
  expect(bridge.validateSettings, "schema-backed launcher validation").toBeTypeOf("function");
  expect(() =>
    bridge.validateSettings(
      { ...fixtureSettings, github: { ...fixtureSettings.github, token: "" } },
      schema,
    ),
  ).toThrow("github.token");
});

it.each([
  { ...fixtureSettings, docker: { memory: "8G" } },
  { ...fixtureSettings, version: 2 },
  { ...fixtureSettings, extra: true },
  { ...fixtureSettings, profiles: [fixtureSettings.profiles[0], fixtureSettings.profiles[0]] },
  { ...fixtureSettings, profiles: [{ id: "bad/id", tool: "codex", auth: { type: "login" } }] },
  {
    ...fixtureSettings,
    profiles: [{ id: "codex", tool: "codex", auth: { type: "token", token: "fake" } }],
  },
  { ...fixtureSettings, docker: { memoryWarningPercent: 101 } },
  {
    ...fixtureSettings,
    github: { ...fixtureSettings.github, gitUser: { name: "bot", email: "invalid" } },
  },
])("keeps standalone validation in parity with the source contract", (value) => {
  const { bridge } = launcher();
  let accepted = true;
  try {
    parseOmiSetting(value);
  } catch {
    accepted = false;
  }
  if (accepted) expect(bridge.validateSettings(value, schema)).toEqual(value);
  else expect(() => bridge.validateSettings(value, schema)).toThrow();
});

it("uses the same authoritative projection for the source runtime launcher", () => {
  const { bridge } = launcher();
  expect(dockerRuntimeEnvironment(parseOmiSetting(fixtureSettings))).toEqual(
    bridge.dockerEnvironment(fixtureSettings, true),
  );
});
