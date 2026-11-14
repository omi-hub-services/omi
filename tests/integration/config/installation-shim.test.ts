import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { installProjectTool } from "../../../src/application/use-cases/project/install-project-tool.js";
import { createProjectInstallation } from "../../../src/infrastructure/config/install-project-package.js";

const execute = promisify(execFile);
let temp: string;
let packageDir: string;
let bin: string;
const store = () =>
  createProjectInstallation({
    sourceRoot: resolve("."),
    provision: async (source, tool) => {
      await mkdir(join(tool, "node_modules"), { recursive: true });
      await symlink(source, join(tool, "node_modules/omi-squad"));
    },
  });

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "omi-installation-shim-"));
  packageDir = join(temp, "package");
  bin = join(temp, "no-node");
  await mkdir(bin);
  await symlink("/usr/bin/dirname", join(bin, "dirname"));
  await mkdir(join(packageDir, "dist/bootstrap"), { recursive: true });
  await mkdir(join(packageDir, "schemas"));
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "omi-squad", version: "0.0.0" }),
  );
  // A dependency-free CLI fixture isolates interpreter selection and argument forwarding.
  await writeFile(
    join(packageDir, "dist/bootstrap/cli.js"),
    "require('node:fs').writeSync(1, JSON.stringify(process.argv.slice(2)) + '\\n');\n",
  );
  for (const path of ["templates", "migrations"])
    await cp(resolve(path), join(packageDir, path), { recursive: true });
});
afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

async function install(name: string) {
  const projectDir = join(temp, name);
  await mkdir(projectDir);
  const input = { projectDir, packageDir, distribution: "Ubuntu", apply: true };
  await installProjectTool(store(), input);
  return { input, shim: join(projectDir, ".omi-squad/bin/omi") };
}

it("runs installed and updated shims without node on PATH", async () => {
  const { input, shim } = await install("project $quote's");
  const args = ["--version", "space value", "quotes' $value *;"];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    expect(await execute(shim, args, { cwd: temp, env: { PATH: bin } })).toMatchObject({
      stdout: `${JSON.stringify(args)}\n`,
    });
    if (attempt === 0) {
      await writeFile(shim, "#!/bin/sh\nexit 99\n");
      await installProjectTool(store(), input);
    }
  }
  const relocated = join(temp, "relocated project");
  await rename(input.projectDir, relocated);
  expect(
    await execute(join(relocated, ".omi-squad/bin/omi"), args, {
      cwd: temp,
      env: { PATH: bin },
    }),
  ).toMatchObject({ stdout: `${JSON.stringify(args)}\n` });
}, 30_000);

it.each([true, false])(
  "handles a removed recorded node with PATH fallback %s",
  async (fallback) => {
    const { shim } = await install(`removed-node-${String(fallback)}`);
    const shell = await readFile(shim, "utf8");
    expect(shell).toContain(process.execPath);
    // Simulate removal of the recorded nvm version without touching the host interpreter.
    await writeFile(shim, shell.replace(process.execPath, join(temp, "removed-node")));
    const fallbackBin = join(temp, `fallback-${String(fallback)}`);
    await mkdir(fallbackBin);
    await symlink("/usr/bin/dirname", join(fallbackBin, "dirname"));
    if (fallback) await symlink(process.execPath, join(fallbackBin, "node"));
    const result = execute(shim, ["--version"], { env: { PATH: fallbackBin } });
    if (fallback) await expect(result).resolves.toMatchObject({ stdout: '["--version"]\n' });
    else {
      await expect(result).rejects.toMatchObject({ code: 127 });
      await expect(result).rejects.toThrow(/Node\.js not found.*reinstall.*PATH/);
    }
  },
  30_000,
);

const runtimeOf = (projectDir: string) =>
  join(projectDir, ".omi-squad/tool/node_modules/omi-squad/dist/bootstrap/runtime.js");

it.each([true, false])(
  "starts only the project runtime and node version through the recorded node, fallback %s",
  async (fallback) => {
    const { input, shim } = await install(`node-exec-${String(fallback)}`);
    const root = input.projectDir;
    await writeFile(
      join(packageDir, "dist/bootstrap/runtime.js"),
      "require('node:fs').writeSync(1, 'runtime ' + JSON.stringify(process.argv.slice(2)));\n",
    );
    const shell = await readFile(shim, "utf8");
    const emptyBin = join(temp, `node-exec-bin-${String(fallback)}`);
    await mkdir(emptyBin);
    await symlink("/usr/bin/dirname", join(emptyBin, "dirname"));
    const runtime = ["--omi-runtime", runtimeOf(root), root];
    // PATH has no node, as under a non-login wsl.exe --exec: only the recorded path can work.
    expect(await execute(shim, runtime, { env: { PATH: emptyBin } })).toMatchObject({
      stdout: `runtime ${JSON.stringify([root])}`,
    });
    expect(
      (await execute(shim, ["--omi-node-version"], { env: { PATH: emptyBin } })).stdout.trim(),
    ).toBe(process.version);
    await writeFile(shim, shell.replace(process.execPath, join(temp, "removed-node")));
    if (fallback) await symlink(process.execPath, join(emptyBin, "node"));
    const result = execute(shim, runtime, { env: { PATH: emptyBin } });
    if (fallback)
      await expect(result).resolves.toMatchObject({ stdout: `runtime ${JSON.stringify([root])}` });
    else await expect(result).rejects.toMatchObject({ code: 127 });
  },
  30_000,
);

it("refuses internal modes with any other script, flag or extra argument without running node", async () => {
  const { input, shim } = await install("internal-mode-refusal");
  const root = input.projectDir;
  const marker = join(temp, "must-not-exist");
  const evil = join(temp, "evil.js");
  await writeFile(evil, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  const runtime = runtimeOf(root);
  for (const args of [
    ["--omi-runtime", evil, root],
    ["--omi-runtime", runtime, root, "extra"],
    ["--omi-runtime", runtime],
    ["--omi-runtime", runtime, join(temp, "other")],
    ["--omi-runtime", "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    ["--omi-runtime"],
    ["--omi-node-version", "-e", "1"],
    ["--omi-node-version", "extra"],
  ])
    await expect(execute(shim, args)).rejects.toMatchObject({ code: 2 });
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("refuses internal modes from the Windows entrypoint without calling wsl.exe", async () => {
  const { shim } = await install("internal-mode-windows");
  const cjs = join(shim + ".cjs");
  for (const mode of ["--omi-runtime", "--omi-node-version"]) {
    await expect(execute(process.execPath, [cjs, mode])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("not available from Windows") as unknown,
    });
  }
});
