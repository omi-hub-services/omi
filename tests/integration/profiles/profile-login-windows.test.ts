import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("runs the Windows bridge with typed WSL argv and logs into only the selected profile store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omi-windows-login-"));
  const root = resolve(import.meta.dirname, "../../..");
  const shebang = `#!${process.execPath}\n`;
  try {
    await mkdir(join(dir, ".omi/bin"), { recursive: true });
    await mkdir(join(dir, "bin"));
    const settings = JSON.stringify({
      version: 1,
      github: { token: "FAKE_GITHUB_VALUE", gitUser: { name: "bot", email: "bot@example.com" } },
      profiles: [{ id: "codex-main", tool: "codex", auth: { type: "login" } }],
    });
    await writeFile(join(dir, ".omi/omisetting.local.json"), settings);
    const wslRecord = join(dir, "wsl-argv.json");
    const wsl = join(dir, "bin/wsl.exe");
    await writeFile(
      wsl,
      shebang +
        `const fs = require('node:fs'); const { spawnSync } = require('node:child_process'); const args = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(wslRecord)}, JSON.stringify(args)); const at = args.indexOf('--exec'); const r = spawnSync(args[at + 1], args.slice(at + 2), { cwd: ${JSON.stringify(dir)}, stdio: 'inherit', shell: false }); process.exitCode = r.status ?? 1;`,
    );
    const shim = join(dir, ".omi/bin/omi");
    await writeFile(
      shim,
      shebang +
        `const { spawnSync } = require('node:child_process'); const r = spawnSync(process.execPath, [${JSON.stringify(join(root, "dist/bootstrap/cli.js"))}, ...process.argv.slice(2)], { stdio: 'inherit', shell: false }); process.exitCode = r.status ?? 1;`,
    );
    const codex = join(dir, "bin/codex");
    await writeFile(
      codex,
      shebang +
        `const fs = require('node:fs'); fs.writeFileSync(process.env.CODEX_HOME + '/auth.json', JSON.stringify({ auth_mode: 'chatgpt', fake: true })); fs.writeFileSync(${JSON.stringify(join(dir, "codex-argv.json"))}, JSON.stringify(process.argv.slice(2)));`,
    );
    for (const executable of [wsl, shim, codex]) await chmod(executable, 0o755);
    const bridge = join(dir, ".omi/bin/omi.cjs");
    await writeFile(
      bridge,
      (await readFile(join(root, "templates/bridges/omi.cjs"), "utf8"))
        .replaceAll("__OMI_DISTRO__", "Ubuntu")
        .replaceAll("__OMI_PROJECT_BASE64__", Buffer.from(dir).toString("base64")),
    );
    const code = await new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, [bridge, "profile", "login", "codex-main"], {
        cwd: dir,
        env: { PATH: join(dir, "bin"), HOME: dir },
        stdio: "ignore",
        shell: false,
      });
      child.once("error", reject);
      child.once("exit", done);
    });
    expect(code).toBe(0);
    expect(JSON.parse(await readFile(wslRecord, "utf8"))).toEqual([
      "--distribution",
      "Ubuntu",
      "--cd",
      dir,
      "--exec",
      shim,
      "profile",
      "login",
      "codex-main",
    ]);
    expect(JSON.parse(await readFile(join(dir, "codex-argv.json"), "utf8"))).toEqual([
      "-c",
      'cli_auth_credentials_store="file"',
      "login",
    ]);
    expect(
      JSON.parse(await readFile(join(dir, ".codex-profiles/codex-main/auth.json"), "utf8")),
    ).toEqual({ auth_mode: "chatgpt", fake: true });
    expect(await readFile(join(dir, ".omi/omisetting.local.json"), "utf8")).toBe(settings);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
