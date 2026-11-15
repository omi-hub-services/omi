import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { baseline } from "../../fixtures/github/project-mapping.ts";
import {
  openStateDatabase,
  type StateDatabase,
} from "../../../src/infrastructure/persistence/sqlite/sqlite-connection.ts";

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

const DIGEST = `sha256:${"c".repeat(64)}`;

it("creates pending business and deploy requests through the runtime and never an approved one", async () => {
  dir = mkdtempSync(join(tmpdir(), "omi-approval-request-"));
  const project = join(dir, "project");
  const squad = join(project, ".omi-squad");
  for (const path of ["config", "roles", "rules", "workflows", "provenance"])
    mkdirSync(join(squad, path), { recursive: true });
  expect(spawnSync("git", ["init", "--initial-branch=develop"], { cwd: project }).status).toBe(0);
  writeFileSync(
    join(squad, "config/project.yaml"),
    stringify({
      ...baseline,
      deploy_targets: [
        { id: "sandbox-r1", target_environment: "sandbox", artifact_digest: DIGEST },
      ],
    }),
  );
  writeFileSync(
    join(squad, "config/models.yaml"),
    "schema_version: 1\nmodels: {}\ncapability_profiles: {}\nverified_models: {}\n",
  );
  writeFileSync(join(squad, "provenance/skills.lock.json"), '{"skills":[]}');
  child = spawn(
    process.execPath,
    [
      "--import",
      resolve("tools/register-ts-imports.ts"),
      resolve("src/bootstrap/runtime.ts"),
      project,
    ],
    { env: { PATH: process.env["PATH"] ?? "" }, stdio: ["pipe", "pipe", "pipe"] },
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
  const hash = "d".repeat(64);
  db.prepare("INSERT INTO projects VALUES ('p','acme/app',NULL,'h','t','t')").run();
  db.prepare("INSERT INTO task_snapshots VALUES ('task-1','p','I_1',1,?,'t','{}','t')").run(hash);

  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        resolve("tools/register-ts-imports.ts"),
        resolve("src/bootstrap/cli.ts"),
        "--json",
        "approvals",
        "request",
        ...args,
      ],
      { cwd: project, encoding: "utf8", timeout: 10000 },
    );
  const business = cli("task-1", "--kind", "business");
  expect(business.status, business.stdout + business.stderr).toBe(0);
  expect(JSON.parse(business.stdout)).toMatchObject({
    result: { version: 0, status: "pending", subject: { kind: "business", baselineHash: hash } },
  });
  const deploy = cli("sandbox-r1", "--kind", "deploy");
  expect(deploy.status, deploy.stdout + deploy.stderr).toBe(0);
  expect(JSON.parse(deploy.stdout)).toMatchObject({
    result: {
      version: 0,
      status: "pending",
      subject: { kind: "deploy", artifactDigest: DIGEST, environment: "sandbox" },
    },
  });
  expect(cli("not-configured", "--kind", "deploy").stdout).toContain("SUBJECT_NOT_FOUND");
  expect(db.prepare("SELECT kind, status, decision FROM approvals ORDER BY kind").all()).toEqual([
    { kind: "business", status: "pending", decision: null },
    { kind: "deploy", status: "pending", decision: null },
  ]);
  const listed = spawnSync(
    process.execPath,
    [
      "--import",
      resolve("tools/register-ts-imports.ts"),
      resolve("src/bootstrap/cli.ts"),
      "approvals",
      "list",
      "--status",
      "pending",
      "--json",
    ],
    { cwd: project, encoding: "utf8", timeout: 10000 },
  );
  expect(listed.status, listed.stdout + listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout)).toMatchObject({
    result: {
      approvals: [
        { version: 0, status: "pending", decidedAt: null },
        { version: 0, status: "pending", decidedAt: null },
      ],
    },
  });
  expect(listed.stdout).not.toMatch(/subjectHash|baselineHash|artifactDigest|evidenceRef|actor/);
}, 30_000);
