import { isAbsolute } from "node:path";
import { GitWorkspaceError } from "../../application/ports/git-workspace.js";

export interface GitWorktreeEntry {
  readonly path: string;
  readonly headSha: string;
  readonly branch: string | null;
  readonly locked: boolean;
}

export function gitObjectId(output: string): string {
  const value = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new GitWorkspaceError("GIT_FAILED");
  }
  return value;
}

/** NUL delimiters preserve spaces, quotes and newlines in paths and lock reasons. */
export function parseWorktrees(output: string): GitWorktreeEntry[] {
  if (!output.endsWith("\0\0")) throw new GitWorkspaceError("GIT_FAILED");
  return output
    .slice(0, -2)
    .split("\0\0")
    .map((record) => {
      const fields = new Map<string, string>();
      for (const field of record.split("\0")) {
        const space = field.indexOf(" ");
        const key = space < 0 ? field : field.slice(0, space);
        const value = space < 0 ? "" : field.slice(space + 1);
        if (
          !["worktree", "HEAD", "branch", "detached", "locked", "prunable"].includes(key) ||
          fields.has(key)
        ) {
          throw new GitWorkspaceError("GIT_FAILED");
        }
        fields.set(key, value);
      }
      const path = fields.get("worktree") ?? "";
      const branch = fields.get("branch");
      if (
        !isAbsolute(path) ||
        (branch === undefined ? !fields.has("detached") : !branch.startsWith("refs/heads/")) ||
        (branch !== undefined && fields.has("detached"))
      ) {
        throw new GitWorkspaceError("GIT_FAILED");
      }
      return {
        path,
        headSha: gitObjectId(fields.get("HEAD") ?? ""),
        branch: branch === undefined ? null : branch.slice("refs/heads/".length),
        locked: fields.has("locked") || fields.has("prunable"),
      };
    });
}

export function parseStatus(output: string): {
  readonly dirty: boolean;
  readonly hasIgnoredFiles: boolean;
} {
  if (output === "") return { dirty: false, hasIgnoredFiles: false };
  if (!output.endsWith("\0")) throw new GitWorkspaceError("GIT_FAILED");
  const records = output.slice(0, -1).split("\0");
  let dirty = false;
  let hasIgnoredFiles = false;
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? "";
    if (!/^[ MADRCU?!T]{2} .+$/s.test(record)) throw new GitWorkspaceError("GIT_FAILED");
    if (record.startsWith("!! ")) hasIgnoredFiles = true;
    else dirty = true;
    if (/^[RC]|^.[RC]/.test(record)) {
      index++;
      if (!records[index]) throw new GitWorkspaceError("GIT_FAILED");
    }
  }
  return { dirty, hasIgnoredFiles };
}
