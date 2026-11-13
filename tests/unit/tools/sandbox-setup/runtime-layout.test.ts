import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLayoutMigration,
  legacyMoves,
  planLayoutMigration,
  runtimeLayout,
} from "../../../../tools/sandbox-setup/runtime-layout.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "omi-042-layout-"));
  dirs.push(dir);
  return dir;
};

describe("runtimeLayout", () => {
  it("uses the paths the runtime reads", () => {
    const layout = runtimeLayout("/p");
    expect(layout.configFile).toBe("/p/.omi-squad/config/project.yaml");
    expect(layout.database).toBe("/p/.omi-squad/local/state/state.sqlite");
    expect(layout.artifactsRoot).toBe("/p/.omi-squad/local/runs");
  });
});

describe("legacy layout", () => {
  const legacy = (dir: string) => {
    writeFileSync(join(dir, "project.yaml"), "yaml");
    writeFileSync(join(dir, "state.db"), "db");
    writeFileSync(join(dir, "state.db-wal"), "wal");
    writeFileSync(join(dir, "state.db-shm"), "shm");
    mkdirSync(join(dir, "artifacts"));
    writeFileSync(join(dir, "artifacts", "a"), "artifact");
  };

  it("plans nothing for an empty or runtime-layout directory", () => {
    expect(planLayoutMigration(temp())).toEqual([]);
  });

  it("moves every legacy file, including the wal and shm, into the runtime layout", () => {
    const dir = temp();
    legacy(dir);
    const moves = planLayoutMigration(dir);
    expect(moves).toHaveLength(5);
    applyLayoutMigration(moves);
    const layout = runtimeLayout(dir);
    expect(readFileSync(layout.configFile, "utf8")).toBe("yaml");
    expect(readFileSync(layout.database, "utf8")).toBe("db");
    expect(readFileSync(`${layout.database}-wal`, "utf8")).toBe("wal");
    expect(readFileSync(`${layout.database}-shm`, "utf8")).toBe("shm");
    expect(readFileSync(join(layout.artifactsRoot, "a"), "utf8")).toBe("artifact");
    expect(legacyMoves(dir)).toEqual([]);
    expect(existsSync(join(dir, "state.db"))).toBe(false);
  });

  it("refuses, and moves nothing, when both layouts exist", () => {
    const dir = temp();
    legacy(dir);
    const layout = runtimeLayout(dir);
    mkdirSync(layout.stateDir, { recursive: true });
    writeFileSync(layout.database, "new");
    expect(() => planLayoutMigration(dir)).toThrow(/both the legacy layout and the runtime layout/);
    expect(existsSync(join(dir, "state.db"))).toBe(true);
  });
});
