import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCliGitWorkspace } from "../../../src/infrastructure/git/cli-git-workspace.ts";
import { gitCommand } from "../../../src/infrastructure/git/git-command.ts";
vi.mock("../../../src/infrastructure/git/git-command.ts", () => ({ gitCommand: vi.fn() }));
const dirs: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("reads bounded committed review deltas without external diff or textconv", () => {
  const main = mkdtempSync(join(tmpdir(), "omi-delta-"));
  dirs.push(main);
  const head = "a".repeat(40);
  const previous = "b".repeat(40);
  vi.mocked(gitCommand).mockImplementation((_cwd, args) => ({
    code: 0,
    stdout: args.includes("--show-toplevel")
      ? `${main}\n`
      : args.includes("worktree")
        ? `worktree ${main}\0HEAD ${head}\0branch refs/heads/develop\0\0`
        : args.includes("diff")
          ? "diff: changed error handling"
          : "",
  }));
  const unused = () => {
    throw new Error("read-only delta must not acquire a lease");
  };
  const workspace = createCliGitWorkspace(
    { mainWorktreePath: main },
    { acquire: unused, renew: unused, release: unused },
  );
  expect(workspace).toHaveProperty("diffSince", expect.any(Function));
  expect(workspace.diffSince?.(main, previous)).toEqual({
    ok: true,
    value: "diff: changed error handling",
  });
  const diff = vi.mocked(gitCommand).mock.calls.find(([, args]) => args.includes("diff"))?.[1];
  expect(diff).toEqual([
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    previous,
    head,
    "--",
  ]);
  expect(workspace.diffSince?.(main, "--output=/tmp/escape")).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});

it("reads changed PR paths relative to the integration merge base", () => {
  const main = mkdtempSync(join(tmpdir(), "omi-paths-"));
  dirs.push(main);
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  vi.mocked(gitCommand).mockImplementation((_cwd, args) => ({
    code: 0,
    stdout: args.includes("--show-toplevel")
      ? `${main}\n`
      : args.includes("worktree")
        ? `worktree ${main}\0HEAD ${head}\0branch refs/heads/develop\0\0`
        : args.includes("merge-base")
          ? `${base}\n`
          : args.includes("--name-only")
            ? "src/domain/approvals/approval.ts\0src/a b.ts\0"
            : "",
  }));
  const unused = () => {
    throw new Error("read only");
  };
  const workspace = createCliGitWorkspace(
    { mainWorktreePath: main },
    { acquire: unused, renew: unused, release: unused },
  );
  expect(workspace.changedPaths?.(main)).toEqual({
    ok: true,
    value: ["src/domain/approvals/approval.ts", "src/a b.ts"],
  });
});
