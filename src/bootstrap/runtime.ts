import { backupState } from "../infrastructure/persistence/sqlite/backup-state.js";
import { wslPathSchema } from "../application/contracts/session-launch.js";
// WSL executable and composition root. Never start it inside the framework source repository.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RuntimeStartupError,
  presentStartupError,
} from "../interfaces/cli/presenters/startup-error-presenter.js";
import { claimProjectSession } from "../application/services/claim-project-session.js";
import { openStateDatabase } from "../infrastructure/persistence/sqlite/sqlite-connection.js";
import {
  applyMigrations,
  loadMigrations,
  readHistory,
} from "../infrastructure/persistence/sqlite/migration-runner.js";
import { createSqliteLeaseStore } from "../infrastructure/persistence/sqlite/sqlite-lease-store.js";
import { createSqliteStateUnitOfWork } from "../infrastructure/persistence/sqlite/sqlite-state-unit-of-work.js";
import { startSessionRuntime } from "../infrastructure/processes/session-runtime.js";
import type { ResourceWakeupTimer } from "../infrastructure/processes/resource-wakeup-loop.js";
import {
  SESSION_HEARTBEAT_TIMEOUT_MS,
  SESSION_LEASE_MS,
} from "../infrastructure/processes/session-timing.js";
import {
  createProfileStores,
  createProfileUseCases,
  createProjectRunCommandUseCases,
  type RuntimeCompositionOptions,
  createRuntimeIpcServer,
  defaultSocketPath,
  ipcErrorLogPath,
  readPackageVersion,
} from "./container.js";

export async function runSessionRuntime(
  projectDir: string,
  options: RuntimeCompositionOptions & { readonly timer?: ResourceWakeupTimer } = {},
): Promise<void> {
  if (!wslPathSchema.safeParse(projectDir).success)
    throw new RuntimeStartupError("PATH_INVALID", "project directory must be an absolute WSL path");
  if (resolve(projectDir) === resolve(import.meta.dirname, "../.."))
    throw new RuntimeStartupError("PATH_INVALID", "cannot run inside framework source");
  const stateDir = join(projectDir, ".omi-squad", "local", "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const database = openStateDatabase(join(stateDir, "state.sqlite"));
  try {
    const migrations = loadMigrations(resolve(import.meta.dirname, "../../migrations"));
    // A fresh DB needs the leases table. Existing owners are checked before any upgrade.
    if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name='leases'").get() === undefined) {
      await backupState(
        database,
        join(projectDir, ".omi-squad", "local", "backups", `migration-${randomUUID()}`),
      );
      applyMigrations(
        database,
        migrations.filter((migration) => migration.version === 1),
      );
    }
    const session = claimProjectSession({
      leases: createSqliteLeaseStore(database),
      state: createSqliteStateUnitOfWork(database),
      owner: randomUUID(),
      now: options.now ?? Date.now,
      nextId: randomUUID,
      leaseMs: SESSION_LEASE_MS,
    });
    let server: ReturnType<typeof createRuntimeIpcServer> | undefined;
    let composition: Awaited<ReturnType<typeof createProjectRunCommandUseCases>> | undefined;
    const runtime = await startSessionRuntime({
      session,
      resourceWakeup: (canDispatch) => {
        const wakeup = composition?.resourceWakeup?.(canDispatch);
        return wakeup === undefined
          ? undefined
          : { ...wakeup, ...(options.timer === undefined ? {} : { timer: options.timer }) };
      },
      owner: {
        channel: process.stdin,
        heartbeatTimeoutMs: SESSION_HEARTBEAT_TIMEOUT_MS,
        signals: ["SIGINT", "SIGTERM", "SIGHUP"],
      },
      startAccepting: async () => {
        if (readHistory(database).length < migrations.length)
          await backupState(
            database,
            join(projectDir, ".omi-squad", "local", "backups", `migration-${randomUUID()}`),
          );
        applyMigrations(database, migrations);
        composition = await createProjectRunCommandUseCases({
          ...options,
          projectDir,
          database,
          session,
          // The callback runs only after startup has returned and the session accepts work.
          startProcess: (worker) => runtime.startWorker(worker),
        });
        server = createRuntimeIpcServer({
          socketPath: defaultSocketPath(projectDir),
          errorLogPath: ipcErrorLogPath(projectDir),
          selections: createProfileStores(database).selections,
          identity: { runtimeVersion: readPackageVersion(), startedAt: session.lease.acquiredAt },
          runs: composition.commands,
          tasks: composition.tasks,
          activeRuns: composition.runs,
          profiles: createProfileUseCases(database, () => runtime.accepting),
          approvals: composition.approvals,
        });
        await server.start();
      },
      stopAccepting: async () => {
        await server?.stop();
      },
      afterWorkersStopped: async () => {
        await composition?.drain();
      },
    });
    if (runtime.accepting) process.stdout.write("ready\n");
    await runtime.result;
  } finally {
    database.close();
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runSessionRuntime(process.argv[2] ?? "");
  } catch (error) {
    process.exitCode = 1;
    // Exit explicitly: an open stdin heartbeat channel would otherwise keep the process alive.
    process.stderr.write(presentStartupError(error), () => process.exit(1));
  }
}
