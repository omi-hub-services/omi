import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { baseline } from "../../fixtures/github/project-mapping.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";
import { sendCommand } from "../../../src/interfaces/ipc/ipc-client.ts";

let child: ChildProcess | undefined;
let dir: string | undefined;
let db: StateDatabase | undefined;
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
  db?.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

it("routes decisions through production runtime composition and authenticates exact GitHub evidence", async () => {
  dir = mkdtempSync(join(tmpdir(), "omi-runtime-approval-"));
  const project = join(dir, "project");
  const squad = join(project, ".omi-squad");
  for (const path of ["config", "roles", "rules", "workflows", "provenance"])
    mkdirSync(join(squad, path), { recursive: true });
  expect(spawnSync("git", ["init", "--initial-branch=develop"], { cwd: project }).status).toBe(0);
  // Empty catalogs are sufficient for deciding an approval; no executor is ever started.
  writeFileSync(
    join(squad, "config/project.yaml"),
    stringify({ ...baseline, policies: { ...baseline.policies, github_approval_actors: ["po"] } }),
  );
  writeFileSync(
    join(squad, "config/models.yaml"),
    "schema_version: 1\nmodels: {}\ncapability_profiles: {}\nverified_models: {}\n",
  );
  writeFileSync(join(squad, "provenance/skills.lock.json"), '{"skills":[]}');
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const commentFile = join(dir, "comment.json");
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}\nimport { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(${JSON.stringify(commentFile)}, 'utf8'));\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
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
  let output = "";
  let error = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    error += chunk.toString();
  });
  await vi.waitFor(
    () => {
      expect(output, error).toContain("ready\n");
    },
    { timeout: 5000 },
  );
  db = openStateDatabase(join(squad, "local/state/state.sqlite"));
  const hash = "a".repeat(64);
  db.prepare("INSERT INTO projects VALUES ('p','acme/app',NULL,'h','t','t')").run();
  db.prepare("INSERT INTO task_snapshots VALUES ('task','p','I_task',1,?,'t','{}','t')").run(hash);
  const socketPath = join(squad, "local/ipc/runtime.sock");
  const request = await sendCommand({
    socketPath,
    timeoutMs: 1000,
    command: {
      schemaVersion: 1,
      command: "approval.request",
      subjectId: "task",
      kind: "business",
    },
  });
  expect(request).toMatchObject({ ok: true });
  if (!request.ok) throw new Error("request failed");
  const id = (request.result as { id: string }).id;
  const args = ["approvals", "decide", id, "--expected-version", "0", "--decision", "approved"];
  const cli = (extra: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        resolve("tools/register-ts-imports.ts"),
        resolve("src/bootstrap/cli.ts"),
        "--json",
        ...args,
        ...extra,
      ],
      { cwd: project, encoding: "utf8", timeout: 10000 },
    );
  expect(cli([]).stdout).toContain("SOURCE_NOT_AUTHENTICATED");
  expect(cli(["--source", "agent-text"]).status).toBe(2);
  const body = JSON.stringify({
    schemaVersion: 1,
    approvalId: id,
    version: 0,
    subjectHash: hash,
    decision: "approved",
  });
  const comment = (login: string, type = "User", edited = false) => {
    writeFileSync(
      commentFile,
      JSON.stringify({
        user: { login, type },
        body,
        created_at: "2026-11-12T00:00:00Z",
        updated_at: edited ? "2026-11-12T00:00:01Z" : "2026-11-12T00:00:00Z",
      }),
    );
  };
  comment("worker", "Bot");
  expect(cli(["--github-comment", "42"]).stdout).toContain("SOURCE_NOT_AUTHENTICATED");
  comment("outsider");
  expect(cli(["--github-comment", "42"]).stdout).toContain("ACTOR_NOT_ALLOWED");
  comment("po", "User", true);
  expect(cli(["--github-comment", "42"]).stdout).toContain("GITHUB_COMMENT_EDITED");
  comment("po");
  const approved = cli(["--github-comment", "42"]);
  expect(approved.status, approved.stdout + approved.stderr).toBe(0);
  expect(JSON.parse(approved.stdout)).toMatchObject({
    result: { status: "approved", decision: { source: "github-actor", actor: "po" } },
  });
  expect(db.prepare("SELECT status FROM approvals WHERE id=?").get(id)).toEqual({
    status: "approved",
  });
}, 30_000);
