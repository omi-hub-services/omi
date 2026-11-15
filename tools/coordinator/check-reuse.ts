// SHA-keyed reuse of the repository check (OMI-168, ADR-0042): a result is kept in the WSL
// checkout's ~/omi-runs/checks, keyed by (check id, exact head SHA, command). Local only; nothing
// is written to GitHub. The runtime counterpart is application/services/reuse-check-runs.ts.
import { createHash } from "node:crypto";
import { RUNS_DIR_FROM_HOME, type WslTarget } from "./coordinator-settings.ts";
import { asNumber, asObject, asString, parseJson } from "./json-shape.ts";
import { wslCommand, type Runner } from "./process-runner.ts";
import "../register-ts-imports.ts";
const { redactDiagnostic } = await import("../../src/domain/shared/redact-diagnostic.ts");

export const CHECK_ID = "project-check";
export const CHECK_ARGV: readonly string[] = ["npm", "run", "check"];

const LOG_LIMIT = 4000;
const SHA = /^[a-f0-9]{40}$/;

export interface StoredCheck {
  readonly checkId: string;
  readonly head: string;
  readonly command: readonly string[];
  readonly status: "passed" | "failed";
  readonly exitCode: number;
  /** Redacted tail of the check output: the log reference handed to later steps. */
  readonly log: string;
}

const fileFor = (checkId: string, head: string, command: readonly string[]): string => {
  if (!SHA.test(head)) throw new Error("stored checks need the full 40-hex head SHA");
  if (!/^[a-z][a-z0-9-]*$/.test(checkId)) throw new Error(`invalid check id: ${checkId}`);
  const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex").slice(0, 16);
  return `$HOME/${RUNS_DIR_FROM_HOME}/checks/${checkId}-${head}-${digest}.json`;
};

/** The stored result for exactly this key, or null; unreadable or mismatching files are missing. */
export async function readStoredCheck(
  run: Runner,
  target: WslTarget,
  head: string,
  checkId: string = CHECK_ID,
  command: readonly string[] = CHECK_ARGV,
): Promise<StoredCheck | null> {
  const result = await run(wslCommand(`cat ${fileFor(checkId, head, command)}`, target, 30_000));
  if (result.code !== 0) return null;
  try {
    const raw = asObject(parseJson(result.stdout, "stored check"), "stored check");
    const status = asString(raw.status, "status");
    const stored: StoredCheck = {
      checkId: asString(raw.checkId, "checkId"),
      head: asString(raw.head, "head"),
      command: asStringArray(raw.command),
      status: status === "passed" ? "passed" : "failed",
      exitCode: asNumber(raw.exitCode, "exitCode"),
      log: asString(raw.log, "log"),
    };
    const matches =
      stored.checkId === checkId &&
      stored.head === head &&
      JSON.stringify(stored.command) === JSON.stringify(command);
    return matches && (status === "passed" || status === "failed") ? stored : null;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("command must be an array");
  return value.map((v) => asString(v, "command"));
}

/** Atomically replaces the stored result of the key; a later run on the same key overwrites it. */
export async function storeCheck(
  run: Runner,
  target: WslTarget,
  check: StoredCheck,
): Promise<void> {
  const file = fileFor(check.checkId, check.head, check.command);
  const log = check.log
    .split("\n")
    .map((line) => redactDiagnostic(line, 400))
    .join("\n")
    .slice(-LOG_LIMIT);
  const result = await run({
    ...wslCommand(
      `mkdir -p $HOME/${RUNS_DIR_FROM_HOME}/checks; cat > ${file}.tmp && mv -f ${file}.tmp ${file}`,
      target,
      30_000,
    ),
    input: JSON.stringify({ schemaVersion: 1, ...check, log }),
  });
  if (result.code !== 0)
    throw new Error(`could not store the check result: ${result.stderr.trim()}`);
}
