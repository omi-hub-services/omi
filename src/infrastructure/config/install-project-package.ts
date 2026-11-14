import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import type {
  InstallationPlan,
  ProjectInstallation,
} from "../../application/ports/project-installation.js";
import {
  frameworkLockSchema,
  type InstallationInput,
  type TemplateFiles,
} from "../../application/contracts/project-installation.js";
import { createProjectConfigStore } from "./project-config-store.js";
import { assertPlainParents, readOptional, readPackageContent } from "./package-content.js";
import {
  installationTarget,
  isProjectInstruction,
  projectInstructionBlock,
  mergeProjectInstruction,
} from "./project-bridge.js";
import { archiveWorkflowTemplate } from "./workflow-template-archive.js";
import { runCommand } from "../processes/run-command.js";
import { openStateDatabase } from "../persistence/sqlite/sqlite-connection.js";
import { applyMigrations, loadMigrations } from "../persistence/sqlite/migration-runner.js";
import { backupState } from "../persistence/sqlite/backup-state.js";
import { createSqliteLeaseStore } from "../persistence/sqlite/sqlite-lease-store.js";
import { PROJECT_OWNER_LEASE_KEY } from "../../application/ports/lease-store.js";

export type ProvisionPackage = (source: string, tool: string) => Promise<void>;
/** npm owns the isolated dependency tree; the application's manifest/lockfile are untouched. */
export const provisionPackage: ProvisionPackage = async (source, tool) => {
  await mkdir(tool, { recursive: true });
  await writeFile(
    join(tool, "package.json"),
    JSON.stringify({ private: true, name: "omi-project-tool", version: "0.0.0" }),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined),
  );
  const packed = await runCommand({
    executable: "npm",
    args: ["pack", "--ignore-scripts", "--json", "--pack-destination", tool, source],
    cwd: tool,
    env,
    timeoutMs: 120_000,
  });
  if (packed.kind !== "finished" || packed.exit.exitCode !== 0)
    throw new Error("PACKAGE_PACK_FAILED");
  const [archive] = z
    .array(z.object({ filename: z.string().regex(/^[A-Za-z0-9._-]+\.tgz$/) }))
    .length(1)
    .parse(JSON.parse(packed.stdout) as unknown);
  if (archive === undefined) throw new Error("PACKAGE_PACK_FAILED");
  const outcome = await runCommand({
    executable: "npm",
    args: [
      "install",
      "--prefix",
      tool,
      "--global=false",
      "--workspaces=false",
      "--save-exact",
      "--no-audit",
      "--no-fund",
      `./${archive.filename}`,
    ],
    cwd: tool,
    env,
    timeoutMs: 120_000,
  });
  if (outcome.kind !== "finished" || outcome.exit.exitCode !== 0)
    throw new Error("PACKAGE_INSTALL_FAILED");
};

export function createProjectInstallation(options: {
  provision?: ProvisionPackage;
  sourceRoot: string;
}): ProjectInstallation {
  async function inspect(input: InstallationInput) {
    const root = await realpath(input.projectDir);
    const sourceRoot = await realpath(options.sourceRoot);
    if (
      root !== resolve(input.projectDir) ||
      root === sourceRoot ||
      root.startsWith(`${sourceRoot}/`) ||
      /^\/mnt\/[a-z](?:\/|$)/i.test(root) ||
      root.startsWith(`${await realpath(input.packageDir)}/`)
    )
      throw new Error("INVALID_INSTALLATION_TARGET");
    await assertPlainParents(root, join(root, ".omi-squad"));
    const squad = join(root, ".omi-squad");
    await assertPlainParents(root, join(squad, "framework.lock.json"));
    const raw = await readOptional(join(squad, "framework.lock.json"));
    const installed =
      raw === undefined ? undefined : frameworkLockSchema.parse(JSON.parse(raw) as unknown);
    if (installed === undefined) {
      for (const path of ["tool", "bin/omi", "bin/omi.cjs"]) {
        await assertPlainParents(root, join(squad, path));
        const exists = await lstat(join(squad, path)).then(
          () => true,
          (error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (exists) throw new Error("UNMANAGED_TOOL_INSTALLATION");
      }
    }
    const content = await readPackageContent(input.packageDir);
    const candidate = frameworkLockSchema.parse({
      ...content,
      base: {
        ...content.base,
        "bridge/skill/bridge.config.json": `${JSON.stringify({ distribution: input.distribution, repository: root, shim: join(squad, "bin", "omi") }, null, 2)}\n`,
      },
      schemaVersion: 1,
      distribution: input.distribution,
      projectDir: root,
    });
    const local: TemplateFiles = {};
    for (const path of new Set([
      ...Object.keys(installed?.base ?? {}),
      ...Object.keys(candidate.base),
    ])) {
      const target = installationTarget(root, path);
      await assertPlainParents(root, target);
      const text = await readOptional(target);
      const managed = isProjectInstruction(path) ? projectInstructionBlock(text) : text;
      if (managed !== undefined) local[path] = managed;
    }
    return { candidate, installed, local };
  }
  async function apply(plan: InstallationPlan) {
    const { input } = plan;
    const squad = join(input.projectDir, ".omi-squad");
    for (const path of [
      "tool",
      "bin/omi",
      "bin/omi.cjs",
      "local/state/state.sqlite",
      "local/backups",
      "local/tmp",
    ])
      await assertPlainParents(input.projectDir, join(squad, path));
    await mkdir(join(squad, "local", "tmp"), { recursive: true, mode: 0o700 });
    const stage = join(squad, "local", "tmp", `install-${randomUUID()}`);
    const backupDir = join(squad, "local", "backups", `install-${randomUUID()}`);
    // Exclusive directory serializes installers; SQLite's owner lease excludes a live runtime.
    const lock = join(squad, "local", "tmp", "installation.lock");
    await mkdir(lock);
    let database: ReturnType<typeof openStateDatabase> | undefined;
    let lease: ReturnType<ReturnType<typeof createSqliteLeaseStore>["acquire"]> | undefined;
    try {
      await mkdir(stage, { recursive: true, mode: 0o700 });
      const fresh = await inspect(input);
      if (
        JSON.stringify(fresh) !==
        JSON.stringify({ candidate: plan.candidate, installed: plan.installed, local: plan.local })
      )
        throw new Error("INSTALLATION_PREVIEW_STALE");
      const stateDir = join(squad, "local", "state");
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const statePath = join(stateDir, "state.sqlite");
      const existed = await lstat(statePath).then(
        () => true,
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
          throw error;
        },
      );
      database = openStateDatabase(statePath);
      const hasLeases =
        database.prepare("SELECT 1 FROM sqlite_schema WHERE name='leases'").get() !== undefined;
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      if (!hasLeases) {
        if (existed) await backupState(database, backupDir);
        applyMigrations(database, loadMigrations(join(input.packageDir, "migrations")).slice(0, 1));
      }
      lease = createSqliteLeaseStore(database).acquire({
        resourceKey: PROJECT_OWNER_LEASE_KEY,
        owner: randomUUID(),
        now: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        reclaimExpired: false,
      });
      if (!lease.ok) throw new Error("PROJECT_OWNER_HELD");
      if (existed && hasLeases) await backupState(database, backupDir);
      const configDir = join(squad, "config");
      await assertPlainParents(input.projectDir, join(configDir, "project.yaml"));
      const configText = await readOptional(join(configDir, "project.yaml"));
      // Reuse the v1 parser/defaults. Unsupported versions fail; no invented legacy conversion.
      const config =
        configText === undefined
          ? undefined
          : await (await createProjectConfigStore(configDir)).read();
      for (const path of [
        "config",
        "framework.lock.json",
        "bin",
        "tool/package.json",
        "tool/package-lock.json",
      ])
        if (
          await lstat(join(squad, path)).then(
            () => true,
            () => false,
          )
        ) {
          await assertPlainParents(input.projectDir, join(squad, path));
          await cp(join(squad, path), join(backupDir, path), {
            recursive: true,
            dereference: false,
          });
        }
      if (plan.installed !== undefined) {
        for (const name of await readdir(join(squad, "tool"))) {
          if (/^[A-Za-z0-9._-]+\.tgz$/.test(name)) {
            await assertPlainParents(input.projectDir, join(squad, "tool", name));
            await cp(join(squad, "tool", name), join(backupDir, "tool", name));
          }
        }
      }
      await writeFile(join(backupDir, "templates.json"), JSON.stringify(plan.local));
      // Runs pin their workflow template by hash; keep what this update is about to replace.
      for (const [path, text] of Object.entries(plan.local))
        if (/^workflows\/[^/]+\.yaml$/.test(path))
          await archiveWorkflowTemplate(join(squad, "local"), text);
      for (const path of new Set(
        [...Object.keys(plan.local), ...Object.keys(plan.candidate.base)].filter((path) =>
          path.startsWith("bridge/"),
        ),
      )) {
        const target = installationTarget(input.projectDir, path);
        await assertPlainParents(input.projectDir, target);
        if ((await readOptional(target)) === undefined) continue;
        await mkdir(dirname(join(backupDir, path)), { recursive: true });
        await cp(target, join(backupDir, path));
      }
      const tool = join(stage, "tool");
      await (options.provision ?? provisionPackage)(input.packageDir, tool);
      const installedPackage = join(tool, "node_modules", "omi-squad");
      const content = await readPackageContent(installedPackage);
      if (content.artifactHash !== plan.candidate.artifactHash)
        throw new Error("PACKAGE_CONTENT_CHANGED");
      const current = await inspect(input);
      if (
        JSON.stringify(current) !== JSON.stringify(fresh) ||
        (await readOptional(join(configDir, "project.yaml"))) !== configText
      )
        throw new Error("INSTALLATION_PREVIEW_STALE");
      // All migration SQL is checksummed by the existing runner, and the backup already exists.
      applyMigrations(database, loadMigrations(join(installedPackage, "migrations")));
      if (database.pragma("integrity_check", { simple: true }) !== "ok")
        throw new Error("STATE_INTEGRITY_FAILED");
      if (
        !createSqliteLeaseStore(database).renew({
          ...lease.lease,
          now: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }).ok
      )
        throw new Error("PROJECT_OWNER_LOST");
      const write = async (path: string, text: string) => {
        await assertPlainParents(input.projectDir, path);
        await mkdir(dirname(path), { recursive: true });
        const temp = join(dirname(path), `.install-${randomUUID()}`);
        await writeFile(temp, text, { mode: 0o600 });
        await rename(temp, path);
      };
      // Preserve config bytes/comments unless materializing an existing schema default is needed.
      if (config !== undefined && configText !== undefined) {
        // Validation and defaults come from the existing config store/contract. The AST edit
        // preserves comments, flow mappings and an explicit YAML document-end marker.
        const document = parseDocument(configText, {
          uniqueKeys: true,
          customTags: [],
          schema: "core",
        });
        if (!document.has("effort_policy")) {
          document.set("effort_policy", config.effort_policy);
          await write(join(configDir, "project.yaml"), document.toString());
        }
      }
      for (const path of new Set([...Object.keys(plan.local), ...Object.keys(plan.merged)])) {
        if (plan.local[path] === plan.merged[path]) continue;
        const target = installationTarget(input.projectDir, path);
        if (isProjectInstruction(path)) {
          await assertPlainParents(input.projectDir, target);
          await write(
            target,
            mergeProjectInstruction(await readOptional(target), plan.merged[path]),
          );
        } else if (plan.merged[path] === undefined) await rm(target);
        else await write(target, plan.merged[path]);
      }
      const previousTool = join(stage, "previous-tool");
      const toolExists = await lstat(join(squad, "tool")).then(
        () => true,
        () => false,
      );
      if (toolExists) await rename(join(squad, "tool"), previousTool);
      try {
        await rename(tool, join(squad, "tool"));
      } catch (error) {
        if (toolExists) await rename(previousTool, join(squad, "tool"));
        throw error;
      }
      const shell = await readFile(
        join(squad, "tool/node_modules/omi-squad/templates/bridges/omi.sh"),
        "utf8",
      );
      const windowsShim = await readFile(
        join(squad, "tool/node_modules/omi-squad/templates/bridges/omi.cjs"),
        "utf8",
      );
      const workerDirs: string[] = [];
      for (const cli of ["claude", "codex"]) {
        for (const directory of (process.env["PATH"] ?? "").split(":")) {
          if (directory === "") continue;
          const executable = resolve(directory, cli);
          try {
            await access(executable, constants.X_OK);
            if (!(await stat(executable)).isFile()) continue;
            workerDirs.push(dirname(executable));
            break;
          } catch {
            // Continue the installer's PATH search, without sourcing shell configuration.
          }
        }
      }
      const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await write(
        join(squad, "bin", "omi"),
        shell
          .replaceAll("__OMI_NODE__", () => shellQuote(process.execPath))
          .replaceAll("__OMI_WORKER_DIRS__", () => shellQuote([...new Set(workerDirs)].join(":"))),
      );
      await chmod(join(squad, "bin", "omi"), 0o755);
      await write(
        join(squad, "bin", "omi.cjs"),
        windowsShim
          .replaceAll("__OMI_DISTRO__", input.distribution)
          .replaceAll("__OMI_PROJECT_BASE64__", Buffer.from(input.projectDir).toString("base64")),
      );
      await write(
        join(squad, "framework.lock.json"),
        `${JSON.stringify(plan.candidate, null, 2)}\n`,
      );
      return { backupDir };
    } finally {
      if (database !== undefined) {
        try {
          if (lease?.ok)
            createSqliteLeaseStore(database).release({
              ...lease.lease,
              now: new Date().toISOString(),
            });
        } finally {
          database.close();
        }
      }
      await rm(stage, { recursive: true, force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
  return { inspect, apply };
}
