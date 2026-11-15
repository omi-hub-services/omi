// OMI-004 PoC support: a two-part edit in a temporary git repository, so a continuation on a
// second profile can be checked on disk: part 1 must survive and part 2 must be done, with no
// other change. The state is read by the harness, never taken from the worker's reply.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointManifest, TwoPartTask } from "./profile-failover.js";

export const PARTS_FILE = "parts.txt";
export const INITIAL_PARTS = "part-1: todo\npart-2: todo\n";
export const FINAL_PARTS = "part-1: done\npart-2: done\n";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=omi-live", "-c", "user.email=omi-live@example.invalid", ...args],
    { cwd, encoding: "utf8", shell: false, timeout: 10_000 },
  );
  if (result.status !== 0) throw new Error(`git ${args[0] ?? ""} failed in the PoC workspace`);
  return result.stdout;
}

/** A fresh repository with one committed `parts.txt`. */
export function createPartsRepo(prefix = "omi-004-continuation-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, PARTS_FILE), INITIAL_PARTS);
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

export function readParts(workspace: string): string {
  return readFileSync(join(workspace, PARTS_FILE), "utf8");
}

/** Porcelain status including untracked and ignored files. */
export function workspaceStatus(workspace: string): string {
  return git(workspace, "status", "--porcelain", "--untracked-files=all", "--ignored").trim();
}

function lineDone(content: string, part: 1 | 2): boolean {
  return content.split("\n").includes(`part-${String(part)}: done`);
}

export const twoPartTask: TwoPartTask = {
  firstPrompt:
    `In ${PARTS_FILE} in the current directory, replace the line 'part-1: todo' with ` +
    `'part-1: done'. Do not change the part-2 line or any other file. Reply 'done'.`,

  nextAction(workspace) {
    const content = readParts(workspace);
    const one = lineDone(content, 1);
    const two = lineDone(content, 2);
    if (one && two && content === FINAL_PARTS) return undefined;
    if (one && !two) {
      return (
        `In ${PARTS_FILE}, replace the line 'part-2: todo' with 'part-2: done'. ` +
        `Part 1 is already done: keep the line 'part-1: done' unchanged.`
      );
    }
    if (!one && !two) {
      return (
        `In ${PARTS_FILE}, replace 'part-1: todo' with 'part-1: done' and ` +
        `'part-2: todo' with 'part-2: done'.`
      );
    }
    return `Make ${PARTS_FILE} contain exactly the two lines 'part-1: done' and 'part-2: done'.`;
  },

  continuationPrompt(checkpoint: CheckpointManifest) {
    // Only checkpoint data: the next action and verified file hashes. No transcript, no prompt
    // or reply of the interrupted attempt.
    const parts = checkpoint.files.find((file) => file.path === PARTS_FILE);
    return (
      `You are continuing a step another worker started; its session is not available. ` +
      `The workspace was verified against checkpoint ${checkpoint.runId}/${checkpoint.stepId} ` +
      `(${PARTS_FILE} sha256 ${parts?.sha256 ?? "missing"}). ` +
      `Remaining work: ${checkpoint.nextAction} Change nothing else. Reply 'done'.`
    );
  },
};
