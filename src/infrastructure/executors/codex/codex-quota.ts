import { spawn } from "node:child_process";
import { z } from "zod";
import type { QuotaReader, QuotaReadResult } from "../../../application/ports/quota-reader.js";
import type { QuotaReading, QuotaWindow } from "../../../domain/profiles/quota-policy.js";
import { buildCodexEnvironment } from "./codex-environment.js";

const DEFAULT_TIMEOUT_MS = 30_000;

const windowSchema = z
  .object({ usedPercent: z.number(), resetsAt: z.number().nullable().optional() })
  .nullable()
  .optional();
const rateLimitsResultSchema = z.object({
  rateLimits: z.object({
    primary: windowSchema,
    secondary: windowSchema,
    rateLimitReachedType: z.string().nullable().optional(),
  }),
  rateLimitResetCredits: z
    .object({ availableCount: z.number().nullable().optional() })
    .nullable()
    .optional(),
});

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Pure parse of `account/rateLimits/read` (codex-cli 0.167.0): `primary` is the 5-hour window and
 * `secondary` the weekly one, `resetsAt` unix seconds. Only quota numbers survive; account ids,
 * plan details and credit ids are dropped. `rateLimitResetCredits.availableCount` is reported and
 * never spent: nothing in this file can ask the app-server to use a credit.
 */
export function parseCodexRateLimits(result: unknown, observedAt: number): QuotaReading {
  const parsed = rateLimitsResultSchema.parse(result);
  const window = (w: z.infer<typeof windowSchema>): QuotaWindow | null =>
    w === null || w === undefined
      ? null
      : {
          usedPercent: round1(w.usedPercent),
          resetsAt: w.resetsAt === null || w.resetsAt === undefined ? null : w.resetsAt * 1000,
        };
  const reached = parsed.rateLimits.rateLimitReachedType ?? null;
  return {
    source: "codex-app-server",
    observedAt,
    fiveHour: window(parsed.rateLimits.primary),
    sevenDay: window(parsed.rateLimits.secondary),
    status: reached ?? "allowed",
    limited: reached !== null,
    resetCredits: parsed.rateLimitResetCredits?.availableCount ?? null,
    modelWindows: [],
  };
}

export interface CodexQuotaReaderOptions {
  /** Read at each call, so a test can swap the executable. */
  readonly executable: string;
  readonly parentEnv: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

type Outcome = { readonly result: unknown } | { readonly note: string };

/** One `codex app-server` conversation: initialize, initialized, account/rateLimits/read. */
function readRateLimits(options: CodexQuotaReaderOptions, profileHome: string): Promise<Outcome> {
  return new Promise((resolve) => {
    let done = false;
    let buffer = "";
    const child = spawn(options.executable, ["app-server"], {
      env: buildCodexEnvironment(options.parentEnv, profileHome),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const finish = (outcome: Outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ note: "codex app-server timed out" });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on("error", () => {
      finish({ note: "codex could not start" });
    });
    child.on("close", () => {
      finish({ note: "codex app-server exited without a result" });
    });
    child.stdin.on("error", () => undefined);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (message.id === 2) {
          finish(
            message.error === undefined
              ? { result: message.result }
              : { note: "account/rateLimits/read failed" },
          );
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "omi-squad-quota", version: "0.0.0" } },
    });
  });
}

/**
 * Codex quota through `codex app-server` on the profile's own `CODEX_HOME`: no model call and no
 * token handling here (the CLI reads its own login). Failures fall back to the last good reading
 * in memory, keeping its original `observedAt`. A probe is never needed, the read is already live.
 */
export function createCodexQuotaReader(options: CodexQuotaReaderOptions): QuotaReader {
  const last = new Map<string, QuotaReading>();
  return {
    async read(profile, { now }): Promise<QuotaReadResult> {
      const outcome = await readRateLimits(options, profile.credentialRef);
      const stale = (note: string): QuotaReadResult => ({
        reading: last.get(profile.credentialRef) ?? null,
        note,
      });
      if ("note" in outcome) return stale(outcome.note);
      try {
        const reading = parseCodexRateLimits(outcome.result, now);
        last.set(profile.credentialRef, reading);
        return { reading, note: null };
      } catch {
        return stale("unexpected response shape");
      }
    },
  };
}
