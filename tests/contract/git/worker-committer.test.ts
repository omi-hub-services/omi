import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gitCommand } from "../../../src/infrastructure/git/git-command.ts";
import { createCliWorkerCommitter } from "../../../src/infrastructure/git/cli-worker-committer.ts";

vi.mock("../../../src/infrastructure/git/git-command.ts");
const baseline = "#!/bin/sh\nexit 0\n";
const hash = (bytes: Buffer) =>
  createHash("sha1")
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");
let cwd: string;
let staged: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "omi-hook-contract-"));
  staged = "";
  mkdirSync(join(cwd, ".husky"));
  writeFileSync(join(cwd, ".husky/pre-commit"), baseline);
  chmodSync(join(cwd, ".husky/pre-commit"), 0o755);
  vi.mocked(gitCommand).mockImplementation((_cwd, args) => {
    if (args[0] === "config") return { code: 0, stdout: ".husky\n" };
    if (args.includes("ls-tree"))
      return { code: 0, stdout: `100755 blob ${hash(Buffer.from(baseline))}\t.husky/pre-commit\0` };
    if (args.includes("diff")) return { code: 0, stdout: staged };
    if (args[0] === "hash-object")
      return { code: 0, stdout: `${hash(readFileSync(args.at(-1) ?? ""))}\n` };
    throw new Error("unexpected Git operation");
  });
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  vi.resetAllMocks();
});

it("accepts unchanged tracked hooks", () => {
  expect(createCliWorkerCommitter().hooksTrusted(cwd)).toBe(true);
});
it.each(["modified", "untracked", "deleted", "staged-only"] as const)(
  "rejects %s hooks",
  (kind) => {
    if (kind === "modified") writeFileSync(join(cwd, ".husky/pre-commit"), "changed\n");
    if (kind === "untracked") writeFileSync(join(cwd, ".husky/extra"), "untracked\n");
    if (kind === "deleted") rmSync(join(cwd, ".husky/pre-commit"));
    if (kind === "staged-only") staged = ".husky/pre-commit\0";
    expect(createCliWorkerCommitter().hooksTrusted(cwd)).toBe(false);
  },
);
