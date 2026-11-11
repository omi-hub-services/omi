import { createHash } from "node:crypto";
import fs from "node:fs";
import { isAbsolute, join } from "node:path";
import { relativePathSchema, sha256Schema } from "../../application/contracts/identifiers.js";
import type {
  UncommittedFile,
  UncommittedManifest,
} from "../../application/contracts/checkpoint.js";
import {
  assertCredentialFree,
  CredentialInputError,
} from "../../application/contracts/credential-input.js";
import {
  GitWorkspaceError,
  type UncommittedLimits,
} from "../../application/ports/git-workspace.js";
import { gitCommand } from "./git-command.js";

export const DEFAULT_MAX_ENTRIES = 500;
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

type Status = UncommittedFile["status"];

function classify(x: string, y: string): Status {
  if (x === "?" && y === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return "conflicted";
  }
  const code = y === " " ? x : y;
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    default:
      return "modified";
  }
}

function isCredentialPath(path: string): boolean {
  try {
    assertCredentialFree(path);
    return false;
  } catch (error) {
    if (error instanceof CredentialInputError) return true;
    throw error;
  }
}

/** Hash of a regular file's bytes, read once through a no-follow descriptor. Never the content. */
function fingerprint(
  worktree: string,
  path: string,
  maxBytes: number,
): { sha256: string | null; size: number | null } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(join(worktree, path), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { sha256: null, size: null };
    if (stat.size > maxBytes) return { sha256: null, size: stat.size };
    const bytes = fs.readFileSync(fd);
    return {
      sha256: sha256Schema.parse(createHash("sha256").update(bytes).digest("hex")),
      size: bytes.byteLength,
    };
  } catch (error) {
    // Missing (deleted), a symlink (ELOOP) or a directory (submodule): listed without a hash.
    if (error instanceof Error && "code" in error) {
      if (["ENOENT", "ELOOP", "EISDIR", "ENOTDIR"].includes(String(error.code))) {
        return { sha256: null, size: null };
      }
    }
    throw new GitWorkspaceError("IO_FAILED");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Staged, unstaged and untracked files of a worktree, bounded by `limits`. Reads only; the index
 * and worktree are untouched. A path that looks like a credential file is counted, never listed or
 * hashed. Files hidden from `git status` by assume-unchanged/skip-worktree flags are not reported.
 */
export function listUncommittedFiles(
  worktree: string,
  limits: UncommittedLimits = {},
): UncommittedManifest {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const output = gitCommand(worktree, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]).stdout;
  const entries: UncommittedFile[] = [];
  let truncated = false;
  let excluded = 0;
  if (output === "") return { entries, truncated, excludedCredentialPaths: 0 };
  if (!output.endsWith("\0")) throw new GitWorkspaceError("GIT_FAILED");

  const records = output.slice(0, -1).split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? "";
    const match = /^([ MADRCUT?])([ MADRCUT?]) (.+)$/s.exec(record);
    if (match === null) throw new GitWorkspaceError("GIT_FAILED");
    const [, x = " ", y = " ", path = ""] = match;
    // A rename/copy record is followed by its origin path, which is not a separate change.
    if (x === "R" || x === "C" || y === "R" || y === "C") index++;
    if (isAbsolute(path) || !relativePathSchema.safeParse(path).success) {
      throw new GitWorkspaceError("GIT_FAILED");
    }
    if (isCredentialPath(path)) {
      excluded++;
      continue;
    }
    if (entries.length >= maxEntries) {
      truncated = true;
      continue;
    }
    const status = classify(x, y);
    entries.push({
      path,
      status,
      staged: x !== " " && x !== "?",
      ...(status === "deleted"
        ? { sha256: null, size: null }
        : fingerprint(worktree, path, maxBytes)),
    });
  }
  return { entries, truncated, excludedCredentialPaths: excluded };
}
