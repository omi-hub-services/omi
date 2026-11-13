import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleasePackage } from "../../application/ports/release-package.js";
import { releaseVersionSchema } from "../../application/contracts/project-installation.js";
import { readOptional } from "../config/package-content.js";
import { runCommand } from "../processes/run-command.js";

/** gh owns authentication; no token is read, persisted or included in diagnostics. */
export function createGithubReleasePackage(run: typeof runCommand = runCommand): ReleasePackage {
  return {
    async prepare(rawVersion) {
      const version = releaseVersionSchema.parse(rawVersion);
      const directory = await mkdtemp(join(tmpdir(), "omi-release-"));
      const cleanup = () => rm(directory, { recursive: true, force: true });
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (pair): pair is [string, string] => pair[1] !== undefined,
        ),
      );
      async function command(executable: string, args: string[], code: string) {
        const outcome = await run({ executable, args, cwd: directory, env, timeoutMs: 120_000 });
        if (
          outcome.kind !== "finished" ||
          outcome.exit.exitCode !== 0 ||
          outcome.exit.timedOut ||
          outcome.exit.stdoutOverflow
        )
          throw new Error(code);
        return outcome.stdout;
      }
      try {
        const name = `omi-squad-${version}.tgz`;
        await command(
          "gh",
          [
            "release",
            "download",
            `v${version}`,
            "--repo",
            "omi-hub-services/omi",
            "--pattern",
            name,
            "--pattern",
            `${name}.sha256`,
            "--dir",
            directory,
          ],
          "RELEASE_DOWNLOAD_FAILED",
        );
        const checksum = await readOptional(join(directory, `${name}.sha256`));
        const match = /^([a-f0-9]{64}) [ *]([^\r\n]+)\r?\n?$/.exec(checksum ?? "");
        if (match === null || match[2] !== name) throw new Error("INVALID_RELEASE_CHECKSUM");
        const digest = createHash("sha256")
          .update(await readFile(join(directory, name)))
          .digest("hex");
        if (digest !== match[1]) throw new Error("RELEASE_CHECKSUM_MISMATCH");
        // Validate paths and entry types before tar can write any archive member.
        const paths = await command(
          "tar",
          ["--quoting-style=escape", "-tzf", name],
          "INVALID_RELEASE_ARCHIVE",
        );
        if (
          !paths.trim() ||
          paths
            .split("\n")
            .filter(Boolean)
            .some(
              (path) =>
                !path.startsWith("package/") ||
                /[\\\r\t]/.test(path) ||
                path.split("/").some((part) => part === ".." || part === "."),
            )
        )
          throw new Error("UNSAFE_RELEASE_ARCHIVE");
        const entries = await command(
          "tar",
          ["--quoting-style=escape", "-tvzf", name],
          "INVALID_RELEASE_ARCHIVE",
        );
        if (
          entries
            .split("\n")
            .filter(Boolean)
            .some((line) => !/^[d-]/.test(line))
        )
          throw new Error("UNSAFE_RELEASE_ARCHIVE");
        await command(
          "tar",
          ["-xzf", name, "--no-same-owner", "--no-same-permissions", "-C", directory],
          "INVALID_RELEASE_ARCHIVE",
        );
        const packageDir = join(directory, "package");
        const changelog = await readOptional(join(packageDir, "CHANGELOG.md"));
        if (changelog === undefined) throw new Error("INVALID_RELEASE_CHANGELOG");
        return { packageDir, changelog, cleanup };
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
  };
}
