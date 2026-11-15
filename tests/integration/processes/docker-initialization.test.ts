import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("rejects repository traversal before invoking Git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omi-docker-init-"));
  const marker = join(directory, "git-called");
  try {
    await writeFile(
      join(directory, "git"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`,
    );
    await chmod(join(directory, "git"), 0o755);
    const child = spawn(process.execPath, [resolve("templates/docker/init.mjs")], {
      env: { PATH: directory },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const exited = new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    });
    child.stdin.end(
      JSON.stringify({
        repo: "..",
        url: "https://github.com/acme/demo.git",
        gitUser: { name: "bot", email: "bot@example.com" },
      }),
    );
    expect(await exited).not.toBe(0);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
