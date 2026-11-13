// Where the runtime keeps a project's files, so a runtime started on the state directory sees the
// same config and database. Mirrors the literals in src/bootstrap/runtime.ts and container.ts
// (config: container.ts loadRuntimeConfig; state: runtime.ts; artifacts: container.ts `local/runs`).
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface RuntimeLayout {
  readonly projectDir: string;
  readonly configDir: string;
  readonly configFile: string;
  readonly stateDir: string;
  readonly database: string;
  readonly artifactsRoot: string;
}

export function runtimeLayout(projectDir: string): RuntimeLayout {
  const root = resolve(projectDir);
  const squad = join(root, ".omi-squad");
  const configDir = join(squad, "config");
  const stateDir = join(squad, "local", "state");
  return {
    projectDir: root,
    configDir,
    configFile: join(configDir, "project.yaml"),
    stateDir,
    database: join(stateDir, "state.sqlite"),
    artifactsRoot: join(squad, "local", "runs"),
  };
}

export interface LayoutMove {
  readonly from: string;
  readonly to: string;
}

/** Earlier versions of local-state wrote these straight into the directory. */
export function legacyMoves(projectDir: string): LayoutMove[] {
  const root = resolve(projectDir);
  const layout = runtimeLayout(root);
  const pairs: [string, string][] = [
    ["project.yaml", layout.configFile],
    ["state.db", layout.database],
    ["state.db-wal", `${layout.database}-wal`],
    ["state.db-shm", `${layout.database}-shm`],
    ["artifacts", layout.artifactsRoot],
  ];
  return pairs
    .map(([name, to]) => ({ from: join(root, name), to }))
    .filter((move) => existsSync(move.from));
}

/** The moves to make; refuses when the legacy files and the runtime files both exist. */
export function planLayoutMigration(projectDir: string): LayoutMove[] {
  const moves = legacyMoves(projectDir);
  if (moves.length === 0) return [];
  const layout = runtimeLayout(projectDir);
  // Every destination, sidecars included: renameSync would silently replace an existing file.
  const present = [
    layout.configFile,
    layout.database,
    layout.artifactsRoot,
    ...moves.map((move) => move.to),
  ].filter((p, index, all) => all.indexOf(p) === index && existsSync(p));
  if (present.length > 0)
    throw new Error(
      `refused: ${layout.projectDir} has both the legacy layout and the runtime layout (${present
        .map((p) => relative(layout.projectDir, p))
        .join(", ")}); keep one by hand`,
    );
  return moves;
}

export const describeMove = (projectDir: string, move: LayoutMove): string =>
  `move ${relative(projectDir, move.from)} to ${relative(projectDir, move.to)}`;

/** No connection to the database may be open while this runs. */
export function applyLayoutMigration(moves: readonly LayoutMove[]): void {
  for (const move of moves) {
    mkdirSync(dirname(move.to), { recursive: true });
    renameSync(move.from, move.to);
  }
}
