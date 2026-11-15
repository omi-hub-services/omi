import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expect, it } from "vitest";

it("runs the installed CommonJS bridge against a fake Docker executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "omi-docker-bridge-"));
  try {
    await mkdir(join(root, ".omi/bin"), { recursive: true });
    await mkdir(join(root, ".omi/tool/node_modules"), { recursive: true });
    await symlink(resolve("."), join(root, ".omi/tool/node_modules/omi-squad"));
    await mkdir(join(root, "bin"));
    const token = "fake-github-bridge";
    await writeFile(
      join(root, ".omi/omisetting.local.json"),
      JSON.stringify({
        version: 1,
        github: { token, gitUser: { name: "bot", email: "bot@example.com" } },
        profiles: [{ id: "test", tool: "codex", auth: { type: "login" } }],
        docker: { container: "omi-test" },
      }),
    );
    const record = join(root, "docker-call.json");
    await writeFile(
      join(root, "bin/docker"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv.slice(2),token:process.env.GH_TOKEN}));\n`,
    );
    await chmod(join(root, "bin/docker"), 0o755);
    const bridge = join(root, ".omi/bin/omi.cjs");
    await copyFile(resolve("templates/bridges/omi.cjs"), bridge);
    const child = spawn(process.execPath, [bridge, "status"], {
      cwd: root,
      env: { PATH: join(root, "bin") },
      stdio: "ignore",
      shell: false,
    });
    const code = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    });
    expect(code).toBe(0);
    const call: unknown = JSON.parse(await readFile(record, "utf8"));
    expect(call).toEqual({
      args: [
        "exec",
        "-i",
        "-e",
        "GH_TOKEN",
        "-w",
        `/work/${basename(root)}`,
        "omi-test",
        `/work/${basename(root)}/.omi/bin/omi`,
        "status",
      ],
      token,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
