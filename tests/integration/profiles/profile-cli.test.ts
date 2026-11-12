import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openStateDatabase } from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import {
  writeFakeCodex,
  fixture as codexFixture,
  readInvocations,
} from "../../contract/executors/codex/fake-codex-cli.ts";
import {
  writeFakeClaude,
  fixture as claudeFixture,
} from "../../contract/executors/claude-code/fake-claude-cli.ts";

let root: string | undefined;
let child: ChildProcess | undefined;
afterEach(async () => {
  if (child !== undefined && child.exitCode === null) {
    const stopped = new Promise<void>((done) =>
      child?.once("close", () => {
        done();
      }),
    );
    child.stdin?.end("stop\n");
    await stopped;
  }
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});
it("registers, lists and probes native profiles through the real runtime without persisting credentials", async () => {
  root = mkdtempSync(join(tmpdir(), "omi-profile-cli-"));
  const project = join(root, "project");
  mkdirSync(project);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const cx = join(root, "codex-profile");
  const cc = join(root, "claude-profile");
  mkdirSync(cx);
  mkdirSync(cc);
  const cache = codexFixture("subscription-cache.json");
  writeFileSync(join(cx, "auth.json"), cache);
  const record = join(root, "codex-calls.jsonl");
  writeFakeCodex(bin, "codex", {}, record);
  writeFakeClaude(
    bin,
    "claude",
    { versionOutput: "2.1.322", authStatusOutput: claudeFixture("auth-status-subscription.json") },
    join(root, "claude-calls.jsonl"),
  );
  child = spawn(
    process.execPath,
    [
      "--import",
      resolve("tools/register-ts-imports.ts"),
      resolve("src/bootstrap/runtime.ts"),
      project,
    ],
    {
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let ready = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    ready += chunk.toString();
  });
  await vi.waitFor(() => {
    expect(ready).toContain("ready\n");
  });
  const cli = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        resolve("tools/register-ts-imports.ts"),
        resolve("src/bootstrap/cli.ts"),
        "--json",
        ...args,
      ],
      {
        cwd: project,
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "" },
        timeout: 10000,
      },
    );
  for (const [id, tool, home] of [
    ["cx", "codex", cx],
    ["cc", "claude-code", cc],
  ]) {
    const result = cli([
      "profiles",
      "register",
      id ?? "",
      "--tool",
      tool ?? "",
      "--profile-home",
      home ?? "",
      "--account-group",
      id ?? "",
      "--model",
      "tested-model",
    ]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const probed = cli(["profiles", "probe", id ?? ""]);
    expect(probed.status, probed.stdout + probed.stderr).toBe(0);
    expect(JSON.parse(probed.stdout)).toMatchObject({ result: { status: "ready" } });
  }
  const listed = cli(["profiles", "list"]);
  expect(listed.status).toBe(0);
  expect(JSON.parse(listed.stdout)).toMatchObject({
    result: {
      profiles: [
        { metadata: { profileId: "cc", state: "ready" } },
        { metadata: { profileId: "cx", state: "ready" } },
      ],
    },
  });
  expect(
    cli([
      "profiles",
      "register",
      "cx",
      "--tool",
      "codex",
      "--profile-home",
      cx,
      "--account-group",
      "cx",
      "--model",
      "tested-model",
    ]).status,
  ).toBe(4);
  expect(cli(["profiles", "probe", "missing"]).status).toBe(4);
  expect(
    cli([
      "profiles",
      "register",
      "unsafe",
      "--tool",
      "codex",
      "--profile-home",
      cx,
      "--account-group",
      "unsafe",
      "--token",
      "synthetic-private",
    ]).status,
  ).toBe(2);
  expect(readFileSync(join(cx, "auth.json"), "utf8")).toBe(cache);
  expect(readInvocations(record)).toMatchObject([{ argv: ["--version"], codexHome: cx }]);
  const db = openStateDatabase(join(project, ".omi-squad/local/state/state.sqlite"));
  try {
    const stored = JSON.stringify(
      db.prepare("SELECT metadata_json FROM profile_observations").all(),
    );
    expect(stored).not.toMatch(/access_token|refresh_token|synthetic/);
    expect(listed.stdout).not.toMatch(/access_token|refresh_token|synthetic/);
  } finally {
    db.close();
  }
}, 15000);
