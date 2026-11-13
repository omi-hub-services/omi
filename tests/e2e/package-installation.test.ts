import { createProjectConfigStore } from "../../src/infrastructure/config/project-config-store.js";
import { runCli } from "../../src/interfaces/cli/commands/create-program.js";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { packAndCheck, validatePackedFiles } from "../../tools/check-package.ts";
import { installProjectTool } from "../../src/application/use-cases/project/install-project-tool.js";
import {
  createProjectInstallation,
  type ProvisionPackage,
  provisionPackage,
} from "../../src/infrastructure/config/install-project-package.js";
import { inspectInstallation } from "../../src/application/use-cases/project/inspect-installation.js";
import {
  createInstallationDoctor,
  type WslProbe,
} from "../../src/infrastructure/processes/installation-doctor.js";
import { openStateDatabase } from "../../src/infrastructure/persistence/sqlite/sqlite-connection.js";
import {
  applyMigrations,
  loadMigrations,
  readHistory,
} from "../../src/infrastructure/persistence/sqlite/migration-runner.js";
import { createSqliteLeaseStore } from "../../src/infrastructure/persistence/sqlite/sqlite-lease-store.js";
import { stringify } from "yaml";
import { initializeProject } from "../../src/application/use-cases/project/initialize-project.js";
import { createCodebaseReader } from "../../src/infrastructure/config/codebase-reader.js";
import { createOnboardingFileStore } from "../../src/infrastructure/config/onboarding-file-store.js";
import { createOnboardingTemplateSource } from "../../src/infrastructure/config/onboarding-template-source.js";
import { baseline } from "../fixtures/github/project-mapping.js";

const root = resolve(import.meta.dirname, "../..");
let temp: string;
let artifact: string;
let archive: string;
let packageVersion: string;
// Package sources stay read-only after preparation; share archive bytes instead of copying
// the full runtime on every fake install. Project state and tool manifests remain independent.
const provision: ProvisionPackage = async (source, tool) => {
  const destination = join(tool, "node_modules", "omi-squad");
  await mkdir(dirname(destination), { recursive: true });
  await symlink(source, destination, "dir");
  await writeFile(
    join(tool, "package.json"),
    JSON.stringify({ private: true, dependencies: { "omi-squad": "file:./omi-squad.tgz" } }),
  );
  await writeFile(join(tool, "package-lock.json"), "{}\n");
};
const store = () => createProjectInstallation({ sourceRoot: root, provision });
async function project(name: string) {
  const path = join(temp, name);
  await mkdir(path);
  return path;
}
async function input(name: string, packageDir = artifact) {
  return { projectDir: await project(name), packageDir, distribution: "Ubuntu-24.04", apply: true };
}
async function candidate(name: string) {
  const path = join(temp, name);
  await cp(artifact, path, { recursive: true });
  return path;
}
const statePath = (projectDir: string) => join(projectDir, ".omi-squad/local/state/state.sqlite");
const textPath = "workflows/onboarding-empty-repo.yaml";
// Five installation cases took 1.64–2.66 s unloaded and exceeded 5 s under ten-way load.
// Their 30 s budgets cover real filesystem/hash/SQLite work remaining after sharing package bytes.

beforeAll(async () => {
  const metadata: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("version" in metadata) ||
    typeof metadata.version !== "string"
  )
    throw new Error("invalid package version");
  packageVersion = metadata.version;
  temp = await mkdtemp(join(tmpdir(), "omi-packaging-"));
  archive = packAndCheck(root, temp);
  artifact = join(temp, "package");
  execFileSync("tar", ["-xzf", archive, "-C", temp]);
  await symlink(join(root, "node_modules"), join(artifact, "node_modules"), "dir");
}, 30_000);
afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("project-local distribution", () => {
  it("updates a release through the package merge, backup and migration path", async () => {
    const request = await input("release-project");
    await installProjectTool(store(), request);
    const packageDir = await candidate("release-package");
    const metadata = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ ...metadata, version: "0.2.0" }),
    );
    const template = join(packageDir, "templates/project/workflows/onboarding-empty-repo.yaml");
    const incoming = `${await readFile(template, "utf8")}\n# release change\n`;
    await writeFile(template, incoming);
    const cleanup = vi.fn(async () => {});
    const releases = {
      prepare: () =>
        Promise.resolve({
          packageDir,
          changelog: "## [0.2.0] - 2026-11-13\n### Breaking\n- Update config\n",
          cleanup,
        }),
    };
    const update = {
      projectDir: request.projectDir,
      distribution: request.distribution,
      version: "0.2.0",
    };
    const preview = await installProjectTool(store(), update, releases);
    expect(preview.status).toBe("preview");
    expect(preview.changes).toContain(textPath);
    const lockPath = join(request.projectDir, ".omi-squad/framework.lock.json");
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ version: packageVersion });
    await expect(installProjectTool(store(), { ...update, apply: true }, releases)).rejects.toThrow(
      "BREAKING_CHANGES_REQUIRE_ACCEPTANCE",
    );
    const result = await installProjectTool(
      store(),
      { ...update, apply: true, acceptBreaking: true },
      releases,
    );
    if (result.status !== "installed") throw new Error("expected installation");
    expect(await readFile(join(request.projectDir, ".omi-squad", textPath), "utf8")).toBe(incoming);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ version: "0.2.0" });
    expect(
      JSON.parse(await readFile(join(result.backupDir, "framework.lock.json"), "utf8")),
    ).toMatchObject({ version: packageVersion });
    expect(cleanup).toHaveBeenCalledTimes(3);
  }, 30_000);
  it("previews the bridge and merges marked instructions while preserving user text and edits", async () => {
    const request = await input("bridge-project");
    await writeFile(join(request.projectDir, "CLAUDE.md"), "# My Claude instructions\n");
    await writeFile(join(request.projectDir, "AGENTS.md"), "# My agent rules\n");
    const preview = await installProjectTool(store(), { ...request, apply: false });
    expect(preview.changes).toContain("bridge/skill/SKILL.md");
    expect(await readdir(request.projectDir)).toEqual(["AGENTS.md", "CLAUDE.md"]);
    const installed = await installProjectTool(store(), request);
    if (installed.status !== "installed") throw new Error("expected install");
    expect(
      await readFile(join(installed.backupDir, "bridge/CLAUDE.md"), "utf8").catch(() => undefined),
    ).toBe("# My Claude instructions\n");
    const skill = join(request.projectDir, ".claude/skills/omi-squad/SKILL.md");
    expect(await readFile(skill, "utf8")).toContain("omi-squad bridge");
    expect(
      await readFile(join(request.projectDir, ".claude/skills/omi-squad/bridge.ts"), "utf8"),
    ).toContain("callCli");
    expect(
      JSON.parse(
        await readFile(
          join(request.projectDir, ".claude/skills/omi-squad/bridge.config.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ distribution: request.distribution, repository: request.projectDir });
    const claude = await readFile(join(request.projectDir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("# My Claude instructions");
    expect(claude).toContain("<!-- omi-squad:start -->");
    expect(await readFile(join(request.projectDir, "AGENTS.md"), "utf8")).toContain(
      "# My agent rules",
    );
    await writeFile(join(request.projectDir, "CLAUDE.md"), `${claude}\nUser addition\n`);
    await writeFile(skill, "# User bridge override\n");
    await installProjectTool(store(), request);
    expect(await readFile(join(request.projectDir, "CLAUDE.md"), "utf8")).toBe(
      `${claude}\nUser addition\n`,
    );
    expect(await readFile(skill, "utf8")).toBe("# User bridge override\n");
    const next = await candidate("bridge-update");
    await writeFile(
      join(next, "templates/bridges/CLAUDE.md"),
      "Read AGENTS.md and use the omi-squad CLI bridge. Updated guidance.\n",
    );
    await installProjectTool(store(), { ...request, packageDir: next });
    const updated = await readFile(join(request.projectDir, "CLAUDE.md"), "utf8");
    expect(updated).toContain("Updated guidance.");
    expect(updated).toContain("User addition");
    expect(updated.match(/<!-- omi-squad:start -->/g)).toHaveLength(1);
  }, 30_000);

  it("refuses a symlinked bridge parent without writing outside the project", async () => {
    const request = await input("bridge-symlink");
    const outside = await project("bridge-outside");
    await symlink(outside, join(request.projectDir, ".claude"));
    await expect(installProjectTool(store(), request)).rejects.toThrow("SYMLINK_INSTALLATION_PATH");
    expect(await readdir(outside)).toEqual([]);
  }, 30_000);

  it.each([
    "<!-- omi-squad:start -->",
    "<!-- omi-squad:end -->\n<!-- omi-squad:start -->",
    "<!-- omi-squad:start --><!-- omi-squad:start --><!-- omi-squad:end -->",
  ])(
    "refuses ambiguous instruction markers without changing bytes: %s",
    async (content) => {
      const request = await input(`markers-${String(content.length)}`);
      const target = join(request.projectDir, "AGENTS.md");
      await writeFile(target, content);
      await expect(installProjectTool(store(), request)).rejects.toThrow(
        "INVALID_INSTRUCTION_MARKERS",
      );
      expect(await readFile(target, "utf8")).toBe(content);
      expect(await readdir(request.projectDir)).toEqual(["AGENTS.md"]);
    },
    30_000,
  );
  it("packs only runtime assets and npm metadata, rejecting accidental source/state", () => {
    const paths = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    expect(paths.some((path) => path.endsWith("/dist/bootstrap/cli.js"))).toBe(true);
    expect(paths.some((path) => /^package\/(src|tests|tools|\.omi-squad)\//.test(path))).toBe(
      false,
    );
    for (const path of [
      "src/bootstrap/cli.ts",
      "templates/project/local/state.sqlite",
      "dist/.env",
      "coverage/index.html",
    ])
      expect(() => {
        validatePackedFiles([{ path }]);
      }).toThrow();
  });

  it("previews without creating runtime directories; installs a relocated shim without a global tool", async () => {
    const request = await input("clean project $quote's");
    await writeFile(join(request.projectDir, "package.json"), '{"name":"user-application"}\n');
    expect((await installProjectTool(store(), { ...request, apply: false })).status).toBe(
      "preview",
    );
    expect(await readdir(request.projectDir)).toEqual(["package.json"]);
    expect((await installProjectTool(store(), request)).status).toBe("installed");
    const shim = join(request.projectDir, ".omi-squad/bin/omi");
    // Only the Node interpreter is on PATH; there is no global omi-squad installation.
    const bin = join(temp, "node-only");
    await mkdir(bin);
    await symlink(process.execPath, join(bin, "node"));
    // The POSIX shim also needs dirname; this is an OS utility, never a framework command.
    await symlink("/usr/bin/dirname", join(bin, "dirname"));
    expect(
      execFileSync(shim, ["--version"], { cwd: temp, env: { PATH: bin }, encoding: "utf8" }).trim(),
    ).toBe(packageVersion);
    expect(await readFile(join(request.projectDir, "package.json"), "utf8")).toBe(
      '{"name":"user-application"}\n',
    );
    const ps = await readFile(join(request.projectDir, ".omi-squad/bin/omi.cjs"), "utf8");
    expect(ps).toContain("Ubuntu-24.04");
    expect(ps).toContain(Buffer.from(request.projectDir).toString("base64"));
    const windowsShim = join(request.projectDir, ".omi-squad/bin/omi.cjs");
    await writeFile(
      join(bin, "wsl.exe"),
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    await chmod(join(bin, "wsl.exe"), 0o755);
    const args = ["status", "--json", "space value", 'quotes" $value *;'];
    const forwarded: unknown = JSON.parse(
      execFileSync(process.execPath, [windowsShim, ...args], {
        env: { PATH: bin },
        encoding: "utf8",
      }),
    );
    expect(forwarded).toEqual([
      "--distribution",
      request.distribution,
      "--cd",
      request.projectDir,
      "--exec",
      shim,
      ...args,
    ]);
    expect(
      spawnSync(process.execPath, [windowsShim, "session", "start", "--project", "/other"], {
        env: { PATH: bin },
      }).status,
    ).toBe(2);
    const db = openStateDatabase(statePath(request.projectDir));
    try {
      expect(readHistory(db)).toHaveLength(loadMigrations(join(artifact, "migrations")).length);
    } finally {
      db.close();
    }
  });

  it("updates untouched templates while preserving independent overrides and local deletions", async () => {
    const request = await input("overrides");
    await installProjectTool(store(), request);
    const target = join(request.projectDir, ".omi-squad", textPath);
    const modelsTarget = join(request.projectDir, ".omi-squad/config/models.yaml");
    expect(await readFile(modelsTarget, "utf8")).toBe(
      await readFile(join(artifact, "templates/project/.omi-squad/config/models.yaml"), "utf8"),
    );
    const customModels = `# project override\n${await readFile(modelsTarget, "utf8")}`;
    await writeFile(modelsTarget, customModels);
    await writeFile(target, "# local override\n");
    await rm(join(request.projectDir, ".omi-squad/workflows/ui-ux.yaml"));
    const next = await candidate("next-package");
    const changed = "workflows/ci-cd.yaml";
    await writeFile(join(next, "templates/project", changed), "# new upstream version\n");
    const result = await installProjectTool(store(), { ...request, packageDir: next });
    expect(result.status).toBe("installed");
    expect(await readFile(target, "utf8")).toBe("# local override\n");
    expect(await readFile(modelsTarget, "utf8")).toBe(customModels);
    expect(await readFile(join(request.projectDir, ".omi-squad", changed), "utf8")).toBe(
      "# new upstream version\n",
    );
    expect(await readdir(join(request.projectDir, ".omi-squad/workflows"))).not.toContain(
      "ui-ux.yaml",
    );
    const lock: unknown = JSON.parse(
      await readFile(join(request.projectDir, ".omi-squad/framework.lock.json"), "utf8"),
    );
    expect(lock).toMatchObject({
      base: { [textPath]: await readFile(join(artifact, "templates/project", textPath), "utf8") },
    });
  }, 30_000);

  // OMI-097: `omi init --apply` and install both supply templates/project/**.
  async function initialize(projectDir: string) {
    const squad = join(projectDir, ".omi-squad");
    await mkdir(join(squad, "config"), { recursive: true });
    return initializeProject(
      {
        github: {
          inspect: () => Promise.reject(new Error("unexpected GitHub call")),
          owner: () => Promise.reject(new Error("unexpected GitHub call")),
        },
        config: await createProjectConfigStore(join(squad, "config")),
        onboarding: {
          codebase: await createCodebaseReader(projectDir),
          files: await createOnboardingFileStore(projectDir),
          templates: createOnboardingTemplateSource(join(artifact, "templates/project/workflows")),
        },
      },
      { config: baseline, apply: true, source: { kind: "codebase", variant: "new" } },
    );
  }
  const walk = async (dir: string) =>
    (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => !path.includes("/.omi-squad/local/") && !path.includes("/.omi-squad/tool/"))
      .sort();

  const snapshot = async (dir: string) =>
    Object.fromEntries(
      await Promise.all(
        (await walk(dir)).map(async (path) => [path, await readFile(path, "utf8")] as const),
      ),
    );

  it("installs and updates over a directory initialised by init, keeping every byte and a consistent lock", async () => {
    const request = await input("init-then-install");
    expect((await initialize(request.projectDir)).kind).toBe("codebase");
    const squad = join(request.projectDir, ".omi-squad");
    const afterInit = await snapshot(request.projectDir);

    expect((await installProjectTool(store(), request)).status).toBe("installed");
    const afterInstall = await snapshot(request.projectDir);
    // Everything init wrote survives install byte for byte; install only adds files.
    for (const [path, text] of Object.entries(afterInit)) expect(afterInstall[path]).toBe(text);

    const lockPath = join(squad, "framework.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { base: Record<string, string> };
    // The lock records the package templates, which init and install both took from the package.
    expect(lock.base[textPath]).toBe(
      await readFile(join(artifact, "templates/project", textPath), "utf8"),
    );
    for (const [path, text] of Object.entries(lock.base))
      if (path.startsWith("workflows/")) expect(afterInstall[join(squad, path)]).toBe(text);

    // Re-running install is stable; an update applies upstream changes and keeps a later user edit.
    const before = await readFile(lockPath, "utf8");
    expect((await installProjectTool(store(), request)).status).toBe("installed");
    expect(await readFile(lockPath, "utf8")).toBe(before);
    const edited = join(squad, textPath);
    await writeFile(edited, "# user edit after install\n");
    const next = await candidate("init-then-update");
    await writeFile(join(next, "templates/project/workflows/ci-cd.yaml"), "# upstream v2\n");
    expect((await installProjectTool(store(), { ...request, packageDir: next })).status).toBe(
      "installed",
    );
    expect(await readFile(edited, "utf8")).toBe("# user edit after install\n");
    expect(await readFile(join(squad, "workflows/ci-cd.yaml"), "utf8")).toBe("# upstream v2\n");
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      base: { "workflows/ci-cd.yaml": "# upstream v2\n" },
    });
  }, 60_000);

  it("reports a file edited after init as a conflict and installs nothing", async () => {
    const request = await input("init-edit-install");
    await initialize(request.projectDir);
    const squad = join(request.projectDir, ".omi-squad");
    await writeFile(join(squad, textPath), "# user edit after init\n");
    const afterInit = await snapshot(request.projectDir);
    expect(await installProjectTool(store(), request)).toMatchObject({
      status: "conflict",
      conflicts: [textPath],
    });
    expect(await snapshot(request.projectDir)).toEqual(afterInit);
    expect(await readdir(squad)).not.toContain("framework.lock.json");
  }, 60_000);

  it("reports divergent edits and deletion conflicts before changing the install or backups", async () => {
    const request = await input("conflicts");
    await installProjectTool(store(), request);
    await rm(join(request.projectDir, ".omi-squad", textPath));
    const next = await candidate("conflicting-package");
    await writeFile(join(next, "templates/project", textPath), "# upstream edit\n");
    const before = await readFile(
      join(request.projectDir, ".omi-squad/framework.lock.json"),
      "utf8",
    );
    const backups = await readdir(join(request.projectDir, ".omi-squad/local/backups"));
    expect(await installProjectTool(store(), { ...request, packageDir: next })).toMatchObject({
      status: "conflict",
      conflicts: [textPath],
    });
    expect(await readFile(join(request.projectDir, ".omi-squad/framework.lock.json"), "utf8")).toBe(
      before,
    );
    expect(await readdir(join(request.projectDir, ".omi-squad/local/backups"))).toEqual(backups);
  }, 30_000);

  it("backs up WAL state and config before applying SQL and existing v1 config defaults", async () => {
    const request = await input("migration");
    const configDir = join(request.projectDir, ".omi-squad/config");
    await mkdir(configDir, { recursive: true });
    const config =
      "# user config comment\n" +
      stringify({
        schema_version: 1,
        repository: { owner: "example", name: "project" },
        project: { owner: "example", number: 1 },
        branches: { integration: "develop", release: "main" },
        limits: { max_parallel_workers: 2, step_timeout_seconds: 120, max_rework_cycles: 4 },
        policies: { mandatory_approvals: ["release", "deploy"] },
      }) +
      "...\n";
    await writeFile(join(configDir, "project.yaml"), config);
    await mkdir(dirname(statePath(request.projectDir)), { recursive: true });
    const writer = openStateDatabase(statePath(request.projectDir));
    applyMigrations(writer, loadMigrations(join(artifact, "migrations")).slice(0, 1));
    writer.exec(
      "CREATE TABLE migration_probe(value TEXT); INSERT INTO migration_probe VALUES ('committed in WAL')",
    );
    try {
      const result = await installProjectTool(store(), request);
      if (!("backupDir" in result)) throw new Error("installation failed");
      const backup = openStateDatabase(join(result.backupDir, "state.sqlite"));
      try {
        expect(readHistory(backup)).toHaveLength(1);
        expect(backup.prepare("SELECT value FROM migration_probe").get()).toEqual({
          value: "committed in WAL",
        });
      } finally {
        backup.close();
      }
      expect(await readFile(join(result.backupDir, "config/project.yaml"), "utf8")).toBe(config);
      expect(await (await createProjectConfigStore(configDir)).read()).toMatchObject({
        effort_policy: { low: "low", medium: "medium", high: "high" },
      });
      expect(await readFile(join(configDir, "project.yaml"), "utf8")).toContain(
        "# user config comment",
      );
      expect(await readFile(join(configDir, "project.yaml"), "utf8")).toContain(
        "mandatory_approvals:",
      );
    } finally {
      writer.close();
    }
  });

  it("retains a usable backup and old runtime/config when a migration fails", async () => {
    const request = await input("failed-migration");
    await installProjectTool(store(), request);
    const before = await readFile(
      join(request.projectDir, ".omi-squad/framework.lock.json"),
      "utf8",
    );
    const next = await candidate("broken-package");
    const count = loadMigrations(join(next, "migrations")).length;
    await writeFile(
      join(next, "migrations", `${String(count + 1).padStart(4, "0")}-broken.sql`),
      "CREATE TABLE should_rollback(value TEXT); SELECT missing_column FROM missing_table;",
    );
    await expect(installProjectTool(store(), { ...request, packageDir: next })).rejects.toThrow();
    expect(await readFile(join(request.projectDir, ".omi-squad/framework.lock.json"), "utf8")).toBe(
      before,
    );
    const db = openStateDatabase(statePath(request.projectDir));
    try {
      expect(
        db.prepare("SELECT name FROM sqlite_schema WHERE name='should_rollback'").get(),
      ).toBeUndefined();
      expect(readHistory(db)).toHaveLength(count);
    } finally {
      db.close();
    }
    const backups = await readdir(join(request.projectDir, ".omi-squad/local/backups"));
    expect(backups).toHaveLength(2);
  }, 30_000);

  it("refuses a running or unreconciled owner and a changed distro binding", async () => {
    const request = await input("live-owner");
    await installProjectTool(store(), request);
    const db = openStateDatabase(statePath(request.projectDir));
    try {
      createSqliteLeaseStore(db).acquire({
        resourceKey: "project-owner",
        owner: "runtime",
        now: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      await expect(installProjectTool(store(), request)).rejects.toThrow("PROJECT_OWNER_HELD");
      await expect(
        installProjectTool(store(), { ...request, distribution: "Other" }),
      ).rejects.toThrow("PROJECT_BINDING_CHANGED");
    } finally {
      db.close();
    }
  }, 30_000);

  it("refuses source targets and symlinked managed paths", async () => {
    await expect(
      installProjectTool(store(), {
        projectDir: root,
        packageDir: artifact,
        distribution: "Ubuntu",
        apply: true,
      }),
    ).rejects.toThrow("INVALID_INSTALLATION_TARGET");
    const request = await input("symlink-target");
    const outside = await project("outside");
    await symlink(outside, join(request.projectDir, ".omi-squad"));
    await expect(installProjectTool(store(), request)).rejects.toThrow("SYMLINK_INSTALLATION_PATH");
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("packaged command wiring", () => {
  it("prints a versioned install preview and fails doctor when WSL evidence is missing", async () => {
    const request = await input("cli-preview");
    const stdout: string[] = [];
    const environment = {
      version: "0.0.0",
      defaultSocketPath: "/unused.sock",
      timeoutMs: 100,
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: () => undefined,
      sendCommand: () => Promise.reject(new Error("unexpected IPC")),
      installation: {
        install: (raw: unknown) => installProjectTool(store(), raw),
        doctor: () =>
          Promise.resolve({
            distribution: request.distribution,
            supported: false,
            checks: [{ name: "interop", ok: false, detail: "not available" }],
          }),
      },
    };
    expect(
      await runCli(
        [
          "install",
          "--project",
          request.projectDir,
          "--package",
          request.packageDir,
          "--distribution",
          request.distribution,
          "--json",
        ],
        environment,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.join("")) as unknown).toMatchObject({
      schemaVersion: 1,
      ok: true,
      result: { status: "preview" },
    });
    expect(await readdir(request.projectDir)).toEqual([]);
    stdout.length = 0;
    expect(
      await runCli(
        [
          "doctor",
          "--project",
          request.projectDir,
          "--distribution",
          request.distribution,
          "--json",
        ],
        environment,
      ),
    ).toBe(6);
    expect(JSON.parse(stdout.join("")) as unknown).toMatchObject({
      schemaVersion: 1,
      ok: false,
      exitCode: 6,
      error: { code: "DOCTOR_FAILED" },
    });
  });
});

describe("installation failure boundaries", () => {
  it("uses real npm pack/install to create a relocatable local tarball lock without registry access", async () => {
    const source = await candidate("dependency-free-package");
    // Fixture removes dependencies solely to test offline npm provisioning. Runtime dependency
    // availability is exercised with the real installed dependencies by the archive smoke above.
    const metadata: unknown = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    if (typeof metadata !== "object" || metadata === null) throw new Error("invalid fixture");
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ ...metadata, dependencies: {}, devDependencies: {} }),
    );
    const tool = join(temp, "real-npm-tool");
    vi.stubEnv("npm_config_cache", join(temp, "offline-cache"));
    vi.stubEnv("npm_config_offline", "true");
    try {
      await provisionPackage(source, tool);
    } finally {
      vi.unstubAllEnvs();
    }
    const manifest: unknown = JSON.parse(await readFile(join(tool, "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      private: true,
      dependencies: { "omi-squad": `file:omi-squad-${packageVersion}.tgz` },
    });
    const relocated = join(temp, "relocated-tool");
    await cp(tool, relocated, { recursive: true });
    expect(await readFile(join(relocated, "package-lock.json"), "utf8")).toContain(
      `file:omi-squad-${packageVersion}.tgz`,
    );
    expect(
      await readFile(join(relocated, "node_modules/omi-squad/dist/bootstrap/cli.js"), "utf8"),
    ).toContain("#!/usr/bin/env node");
  }, 30_000);

  it("refuses edits made while npm is installing, preserving the user's latest bytes", async () => {
    const request = await input("concurrent-edit");
    await installProjectTool(store(), request);
    const target = join(request.projectDir, ".omi-squad", textPath);
    const adapter = createProjectInstallation({
      sourceRoot: root,
      provision: async (source, tool) => {
        await provision(source, tool);
        await writeFile(target, "# changed during provisioning\n");
      },
    });
    await expect(installProjectTool(adapter, request)).rejects.toThrow(
      "INSTALLATION_PREVIEW_STALE",
    );
    expect(await readFile(target, "utf8")).toBe("# changed during provisioning\n");
  }, 30_000);
});

describe("WSL2 doctor", () => {
  it("classifies a failed doctor probe without exposing exception text", async () => {
    let output = "";
    const code = await runCli(
      ["--json", "doctor", "--project", "/home/user/project", "--distribution", "Ubuntu"],
      {
        sendCommand: () => Promise.reject(new Error("unexpected IPC")),
        defaultSocketPath: "/unused",
        timeoutMs: 100,
        version: "1",
        stdout: (text) => {
          output += text;
        },
        stderr: () => undefined,
        installation: {
          install: () => Promise.reject(new Error("unexpected install")),
          doctor: () => Promise.reject(new Error("synthetic-private-error")),
        },
      },
    );
    expect(code).toBe(6);
    expect(JSON.parse(output)).toMatchObject({ error: { code: "DOCTOR_FAILED" } });
    expect(output).not.toContain("synthetic-private-error");
  }, 30_000);
  it("returns a dedicated CLI failure code for unsupported installations", async () => {
    let output = "";
    const code = await runCli(
      ["--json", "doctor", "--project", "/home/user/project", "--distribution", "Ubuntu"],
      {
        sendCommand: () => Promise.reject(new Error("unexpected IPC")),
        defaultSocketPath: "/unused",
        timeoutMs: 100,
        version: "1",
        stdout: (text) => {
          output += text;
        },
        stderr: () => undefined,
        installation: {
          install: () => Promise.reject(new Error("unexpected install")),
          doctor: () =>
            Promise.resolve({
              supported: false,
              distribution: "Ubuntu",
              checks: [{ name: "interop", ok: false, detail: "unavailable" }],
            }),
        },
      },
    );
    expect(code).toBe(6);
    expect(JSON.parse(output)).toMatchObject({ error: { code: "DOCTOR_FAILED" }, exitCode: 6 });
  }, 30_000);
  function probe(overrides: Partial<WslProbe> = {}): WslProbe {
    return {
      kernel: () => Promise.resolve("6.6.87-microsoft-standard-WSL2"),
      distro: () => "Ubuntu",
      interop: () => Promise.resolve(true),
      canonical: (path) => Promise.resolve(path),
      command: (executable, args) => {
        if (executable === "wsl.exe")
          return Promise.resolve(
            args[0] === "--list" ? "  NAME STATE VERSION\n* Ubuntu Running 2" : "0.0.0",
          );
        return Promise.resolve(
          args[0] === "-w"
            ? "\\\\wsl.localhost\\Ubuntu\\home\\user\\project"
            : "/home/user/project",
        );
      },
      ...overrides,
    };
  }
  const request = { projectDir: "/home/user/project", distribution: "Ubuntu" };
  it("verifies distro version, interop and round-trip path mapping with typed argv", async () => {
    expect((await inspectInstallation(createInstallationDoctor(probe()), request)).supported).toBe(
      true,
    );
  });
  it.each([
    { kernel: () => Promise.resolve("Linux") },
    { distro: () => "Other" },
    { interop: () => Promise.resolve(false) },
    { canonical: () => Promise.resolve("/mnt/c/project") },
    { command: () => Promise.resolve(undefined) },
  ])("fails closed for missing WSL capabilities: %j", async (override) => {
    expect(
      (await inspectInstallation(createInstallationDoctor(probe(override)), request)).supported,
    ).toBe(false);
  });
});
