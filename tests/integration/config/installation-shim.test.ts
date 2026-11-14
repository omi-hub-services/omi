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

it.each([true, false])(
  "runs a script through the recorded node in --omi-node-exec mode, fallback %s",
  async (fallback) => {
    const { shim } = await install(`node-exec-${String(fallback)}`);
    const script = join(temp, `script-${String(fallback)}.js`);
    await writeFile(
      script,
      "require('node:fs').writeSync(1, JSON.stringify(process.argv.slice(2)));\n",
    );
    const shell = await readFile(shim, "utf8");
    const emptyBin = join(temp, `node-exec-bin-${String(fallback)}`);
    await mkdir(emptyBin);
    await symlink("/usr/bin/dirname", join(emptyBin, "dirname"));
    const args = ["--omi-node-exec", script, "a b", "c"];
    // PATH has no node, as under a non-login wsl.exe --exec: only the recorded path can work.
    expect(await execute(shim, args, { env: { PATH: emptyBin } })).toMatchObject({
      stdout: '["a b","c"]',
    });
    await writeFile(shim, shell.replace(process.execPath, join(temp, "removed-node")));
    if (fallback) await symlink(process.execPath, join(emptyBin, "node"));
    const result = execute(shim, args, { env: { PATH: emptyBin } });
    if (fallback) await expect(result).resolves.toMatchObject({ stdout: '["a b","c"]' });
    else await expect(result).rejects.toMatchObject({ code: 127 });
  },
  30_000,
);
