import { wslTarget } from "./coordinator-target.ts";
// Repository bootstrap policy only: no dependency on the develop framework being repaired.
import { z } from "zod";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";

export const PIN_DIRECTORY_NAME = "omi-coordinator-pin";
export const pinShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const pinSourceSchema = z.union([
  z.enum(["main", "develop"]),
  z.string().regex(/^tag:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
]);
const revision = z.strictObject({ sha: pinShaSchema, source: pinSourceSchema });
const pinRecordSchema = revision
  .extend({
    schemaVersion: z.literal(1),
    previous: revision.nullable(),
  })
  .refine((record) => record.previous?.sha !== record.sha, "rollback SHA must differ");
export type PinSource = z.infer<typeof pinSourceSchema>;
export type PinRecord = z.infer<typeof pinRecordSchema>;
export const parsePinRecord = (value: unknown): PinRecord => pinRecordSchema.parse(value);

export function refreshedRecord(record: PinRecord, sha: string, source: PinSource): PinRecord {
  return parsePinRecord({
    schemaVersion: 1,
    sha,
    source,
    previous: sha === record.sha ? record.previous : { sha: record.sha, source: record.source },
  });
}

export interface PinCheck {
  readonly id?: number;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
}
export function refreshRefusal(facts: {
  provenance: boolean;
  checks: readonly PinCheck[];
}): string | undefined {
  if (!facts.provenance) return "PIN_SOURCE_NOT_VERIFIED";
  const check = facts.checks
    .filter((c) => c.name === "check")
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
  return check?.status === "completed" && check.conclusion === "success"
    ? undefined
    : "PIN_CHECK_NOT_GREEN";
}

export function assertSeparatePin(checkout: string, workRoot: string): void {
  const contains = (parent: string, child: string) => {
    const path = relative(resolve(parent), resolve(child));
    return (
      path === "" ||
      (!path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
        path !== ".." &&
        !isAbsolute(path))
    );
  };
  if (contains(checkout, workRoot) || contains(workRoot, checkout))
    throw new Error("PIN_CHECKOUT_OVERLAPS_WORKTREE");
}
export function pinCheckoutPath(repoRoot: string, configured?: string): string {
  if (configured !== undefined && !isAbsolute(configured))
    throw new Error("PIN_PATH_MUST_BE_ABSOLUTE");
  const path = configured ?? join(dirname(resolve(repoRoot)), PIN_DIRECTORY_NAME);
  assertSeparatePin(path, repoRoot);
  return path;
}

/** Windows .cmd launch needs a shell; use the Node distribution's bundled npm CLI instead. */
export function pinInstallCommand(platform: NodeJS.Platform, node: string, cwd: string) {
  return {
    file: platform === "win32" ? node : "npm",
    args:
      platform === "win32"
        ? [
            win32.join(win32.dirname(node), "node_modules/npm/bin/npm-cli.js"),
            "ci",
            "--ignore-scripts",
          ]
        : ["ci", "--ignore-scripts"],
    cwd,
    timeoutMs: 600_000,
  };
}

export function pinWorkRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const target = wslTarget(platform, env);
  return platform === "win32" && target.repoDir.startsWith("/")
    ? `\\\\wsl.localhost\\${target.distro}${target.repoDir.replaceAll("/", "\\")}`
    : target.repoDir;
}
