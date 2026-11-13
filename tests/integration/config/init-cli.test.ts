import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { baseline } from "../../fixtures/github/project-mapping.ts";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function cli(project: string, args: string[]) {
  return spawnSync(
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
    },
  );
}
it("previews init without writes, applies config through onboarding, and keeps user config on repeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "omi-init-cli-"));
  temps.push(root);
  const project = join(root, "project");
  await mkdir(project);
  const config = join(root, "baseline.json");
  await writeFile(config, JSON.stringify(baseline));
  const args = ["init", "--project", project, "--config", config];
  const preview = cli(project, args);
  expect(preview.status, preview.stdout + preview.stderr).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({ result: { status: "preview" } });
  expect(await readdir(project)).toEqual([]);
  expect(cli(project, [...args, "--apply"]).status).toBe(0);
  const modelsTarget = join(project, ".omi-squad/config/models.yaml");
  const defaultModels = await readFile(
    resolve("templates/project/.omi-squad/config/models.yaml"),
    "utf8",
  );
  expect(await readFile(modelsTarget, "utf8")).toBe(defaultModels);
  const customModels = `# project model override\n${defaultModels}`;
  await writeFile(modelsTarget, customModels);
  const target = join(project, ".omi-squad/config/project.yaml");
  const content = await readFile(target, "utf8");
  await writeFile(target, `# user comment\n${content}`);
  expect(cli(project, [...args, "--apply"]).status).toBe(0);
  expect(await readFile(target, "utf8")).toBe(`# user comment\n${content}`);
  expect(await readFile(modelsTarget, "utf8")).toBe(customModels);
  // Supply the test workflow used to exercise command refusal without an imported task.
  await cp(
    resolve("tests/fixtures/workflows/minimal-delivery.yaml"),
    join(project, ".omi-squad/workflows/minimal-delivery.yaml"),
  );
  expect(spawnSync("git", ["init", "--initial-branch=develop"], { cwd: project }).status).toBe(0);
  const child = spawn(
    process.execPath,
    [
      "--import",
      resolve("tools/register-ts-imports.ts"),
      resolve("src/bootstrap/runtime.ts"),
      project,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const stopped = new Promise<void>((done) =>
    child.once("close", () => {
      done();
    }),
  );
  let output = "";
  let error = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    error += chunk.toString();
  });
  try {
    await vi.waitFor(
      () => {
        expect(output, error).toContain("ready\n");
      },
      { timeout: 5000 },
    );
    for (const args of [
      ["plan", "--issue", "1", "--workflow", "minimal-delivery"],
      ["dispatch", "--run", "missing", "--step", "implement"],
    ]) {
      const response = cli(project, args);
      expect(response.status).toBe(4);
      expect(response.stdout).not.toContain("PROJECT_NOT_CONFIGURED");
      expect(response.stdout).not.toContain("NOT_IMPLEMENTED");
      expect(JSON.parse(response.stdout)).toMatchObject({ error: { code: "COMMAND_REFUSED" } });
    }
  } finally {
    child.stdin.end("stop\n");
    await stopped;
  }
}, 30_000);

it("refuses malformed baseline data without echoing input or creating project files", async () => {
  const root = await mkdtemp(join(tmpdir(), "omi-init-invalid-"));
  temps.push(root);
  const project = join(root, "project");
  await mkdir(project);
  const config = join(root, "invalid.json");
  await writeFile(config, JSON.stringify({ token: "synthetic-private-value" }));
  const result = cli(project, ["init", "--project", project, "--config", config, "--apply"]);
  expect(result.status).toBe(2);
  expect(result.stdout + result.stderr).not.toContain("synthetic-private-value");
  expect(await readdir(project)).toEqual([]);
}, 30_000);

it("refuses the framework source and relative project paths even for a preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "omi-init-boundary-"));
  temps.push(root);
  const config = join(root, "baseline.json");
  await writeFile(config, JSON.stringify(baseline));
  for (const project of [resolve("."), "."]) {
    const result = cli(root, ["init", "--project", project, "--config", config]);
    expect(result.status, result.stdout).toBe(2);
  }
}, 30_000);
