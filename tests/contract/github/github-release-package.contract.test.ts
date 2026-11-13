import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGithubReleasePackage } from "../../../src/infrastructure/github/github-release-package.js";
import type { runCommand } from "../../../src/infrastructure/processes/run-command.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function harness(mode = "ok") {
  const root = await mkdtemp(join(tmpdir(), "omi-release-contract-"));
  roots.push(root);
  const source = join(root, "package");
  await mkdir(source);
  await writeFile(
    join(source, "CHANGELOG.md"),
    "# Changelog\n## [0.2.0] - 2026-11-13\n### Breaking\n",
  );
  await writeFile(join(source, "package.json"), '{"name":"omi-squad","version":"0.2.0"}');
  if (mode === "symlink") await symlink("/tmp", join(source, "escape"));
  const archive = join(root, "source.tgz");
  await exec("tar", ["-czf", archive, "-C", root, "package"]);
  let downloadDir = "";
  const calls: { executable: string; args: readonly string[] }[] = [];
  const run: typeof runCommand = async (options) => {
    calls.push(options);
    if (options.executable === "gh") {
      downloadDir = options.cwd;
      if (mode === "unavailable") return { kind: "spawn-failed" };
      if (mode === "missing")
        return {
          kind: "finished",
          exit: {
            exitCode: 1,
            signal: null,
            durationMs: 0,
            stderr: "release not found",
            cancelRequested: false,
            timedOut: false,
            stdoutOverflow: false,
            escalated: false,
            leftoverProcessesKilled: false,
          },
          stdout: "",
        };
      const bytes = await readFile(archive);
      const name = "omi-squad-0.2.0.tgz";
      await writeFile(join(downloadDir, name), bytes);
      const hash =
        mode === "mismatch" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex");
      await writeFile(
        join(downloadDir, `${name}.sha256`),
        `${hash}  ${mode === "wrong-name" ? "other.tgz" : name}\n`,
      );
      return {
        kind: "finished",
        exit: {
          exitCode: 0,
          signal: null,
          durationMs: 0,
          stderr: "",
          cancelRequested: false,
          timedOut: false,
          stdoutOverflow: false,
          escalated: false,
          leftoverProcessesKilled: false,
        },
        stdout: "",
      };
    }
    return {
      kind: "finished",
      exit: {
        exitCode: 0,
        signal: null,
        durationMs: 0,
        stderr: "",
        cancelRequested: false,
        timedOut: false,
        stdoutOverflow: false,
        escalated: false,
        leftoverProcessesKilled: false,
      },
      stdout: (
        await exec(options.executable, [...options.args], { cwd: options.cwd, encoding: "utf8" })
      ).stdout,
    };
  };
  return { run, calls, downloadDir: () => downloadDir };
}

describe("GitHub release package boundary", () => {
  it("downloads the two exact assets from the pinned repository and extracts verified bytes", async () => {
    const h = await harness();
    const release = await createGithubReleasePackage(h.run).prepare("0.2.0");
    expect(h.calls[0]).toMatchObject({
      executable: "gh",
      args: [
        "release",
        "download",
        "v0.2.0",
        "--repo",
        "omi-hub-services/omi",
        "--pattern",
        "omi-squad-0.2.0.tgz",
        "--pattern",
        "omi-squad-0.2.0.tgz.sha256",
        "--dir",
        h.downloadDir(),
      ],
    });
    expect(
      JSON.parse(await readFile(join(release.packageDir, "package.json"), "utf8")),
    ).toMatchObject({ version: "0.2.0" });
    expect(release.changelog).toContain("### Breaking");
    await release.cleanup();
    await expect(access(h.downloadDir())).rejects.toThrow();
  });
  it.each([
    ["mismatch", "RELEASE_CHECKSUM_MISMATCH"],
    ["wrong-name", "INVALID_RELEASE_CHECKSUM"],
    ["missing", "RELEASE_DOWNLOAD_FAILED"],
    ["unavailable", "RELEASE_DOWNLOAD_FAILED"],
    ["symlink", "UNSAFE_RELEASE_ARCHIVE"],
  ])("refuses %s before extraction and removes downloads", async (mode, code) => {
    const h = await harness(mode);
    await expect(createGithubReleasePackage(h.run).prepare("0.2.0")).rejects.toThrow(code);
    expect(h.calls.some((call) => call.args.includes("-xzf"))).toBe(false);
    await expect(access(h.downloadDir())).rejects.toThrow();
  });
});
