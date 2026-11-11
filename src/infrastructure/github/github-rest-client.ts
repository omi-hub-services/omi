import { backoffDelayMs } from "../../domain/runs/retry-policy.js";
import type { RetryBudget } from "../../domain/runs/retry-policy.js";
import { TransportError } from "./github-transport.js";
import type { GithubTransport, HttpRequest, HttpResponse } from "./github-transport.js";

/**
 * Retry, backoff, rate-limit and pagination handling over a transport (architecture.md §11).
 *
 * The client keeps one rule above all: **it only repeats a request whose effect it knows was not
 * applied.** A read can always be repeated. A write is repeated only after GitHub answered with a
 * refusal (rate limit); when the call timed out, the connection broke or GitHub answered 5xx,
 * the write may have been applied and the client reports `unknown` instead of trying again. The
 * caller (the outbox) then reads the remote back by the operation marker.
 */
export interface RestPolicy {
  /** Total tries of one request for transient failures and rate-limit waits (first try included). */
  readonly maxTries: number;
  readonly backoff: RetryBudget;
  /** Longest wait the client sleeps through itself; a longer wait is handed back to the caller. */
  readonly maxInlineWaitMs: number;
  /** Pages one listing may read before it is reported as incomplete. */
  readonly maxPages: number;
}

export const DEFAULT_REST_POLICY: RestPolicy = {
  maxTries: 4,
  backoff: { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 30_000 },
  maxInlineWaitMs: 60_000,
  maxPages: 20,
};

/** Without a hint, GitHub asks clients to wait at least a minute after a secondary rate limit. */
const SECONDARY_LIMIT_MIN_WAIT_MS = 60_000;
/** Reset times are whole seconds; leave a margin so the retry lands after the reset. */
const RESET_MARGIN_MS = 1_000;

export interface RestClientDeps {
  readonly transport: GithubTransport;
  /** Waits; a value so tests never sleep. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Epoch ms. */
  readonly now: () => number;
  /** Random value in [0, 1) that spreads retries. */
  readonly random: () => number;
  readonly policy?: Partial<RestPolicy>;
}

export type RestResult =
  | {
      readonly kind: "ok";
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      /** Parsed JSON body; `undefined` for an empty body. */
      readonly json: unknown;
    }
  /** GitHub answered and applied nothing. `retryable` is true for rate limits only. */
  | {
      readonly kind: "rejected";
      readonly retryable: boolean;
      readonly code: string;
      readonly retryAfterMs?: number;
    }
  /** A write whose effect may exist: timeout, broken connection, 5xx, unreadable success body. */
  | { readonly kind: "unknown"; readonly code: string }
  /** A read that could not be completed. */
  | { readonly kind: "unavailable"; readonly code: string };

export type PageVisit = "continue" | "stop" | "invalid";

export type PagesResult =
  /** Every page was read; the visitor never asked to stop. */
  | { readonly kind: "complete" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly code: string };

export interface GithubRestClient {
  request(request: HttpRequest): Promise<RestResult>;
  /** Reads a paginated GET listing page by page, following `Link: rel="next"`. */
  readPages(path: string, visit: (page: unknown) => PageVisit): Promise<PagesResult>;
}

export function createGithubRestClient(deps: RestClientDeps): GithubRestClient {
  const policy: RestPolicy = { ...DEFAULT_REST_POLICY, ...deps.policy };
  // The most recent primary rate-limit reading (X-RateLimit-Remaining / -Reset).
  let exhaustedUntil = 0;

  const backoff = (tryIndex: number): number =>
    backoffDelayMs(tryIndex, deps.random(), policy.backoff);

  async function request(req: HttpRequest): Promise<RestResult> {
    const isRead = req.method === "GET";
    for (let attempt = 1; ; attempt += 1) {
      const last = attempt >= policy.maxTries;

      // Do not spend a request that is known to be refused until the limit resets.
      const blockedFor = exhaustedUntil - deps.now();
      if (blockedFor > 0) {
        if (blockedFor > policy.maxInlineWaitMs) {
          return {
            kind: "rejected",
            retryable: true,
            code: "RATE_LIMITED",
            retryAfterMs: blockedFor,
          };
        }
        await deps.sleep(blockedFor);
      }

      let response: HttpResponse;
      try {
        response = await deps.transport.send(req);
      } catch (error) {
        if (!(error instanceof TransportError)) throw error;
        if (error.failure === "not_installed") {
          return { kind: "rejected", retryable: false, code: "GH_NOT_INSTALLED" };
        }
        if (error.failure === "auth_required") {
          return { kind: "rejected", retryable: false, code: "AUTH_REQUIRED" };
        }
        const code = error.failure === "timeout" ? "TIMEOUT" : "CONNECTION_FAILED";
        // A write may have reached GitHub before the failure: never repeat it blindly.
        if (!isRead) return { kind: "unknown", code };
        if (last) return { kind: "unavailable", code };
        await deps.sleep(backoff(attempt - 1));
        continue;
      }

      noteRateLimit(response.headers);
      const { status } = response;

      if (status >= 200 && status < 300) {
        const json = parseJson(response.body);
        if (json === INVALID_JSON) {
          return isRead
            ? { kind: "unavailable", code: "INVALID_RESPONSE" }
            : { kind: "unknown", code: "INVALID_RESPONSE" };
        }
        return { kind: "ok", status, headers: response.headers, json };
      }

      if (isRateLimited(response)) {
        const wait = rateLimitWait(response, attempt - 1);
        if (wait > policy.maxInlineWaitMs || last) {
          return { kind: "rejected", retryable: true, code: "RATE_LIMITED", retryAfterMs: wait };
        }
        await deps.sleep(wait);
        continue;
      }

      if (status === 401) return { kind: "rejected", retryable: false, code: "AUTH_REQUIRED" };

      if (status >= 500 || status === 408) {
        if (!isRead) return { kind: "unknown", code: `HTTP_${String(status)}` };
        if (last) return { kind: "unavailable", code: `HTTP_${String(status)}` };
        const hinted = retryAfterMs(response.headers, deps.now());
        await deps.sleep(
          Math.min(Math.max(hinted ?? 0, backoff(attempt - 1)), policy.maxInlineWaitMs),
        );
        continue;
      }

      if (status >= 400) {
        return { kind: "rejected", retryable: false, code: `HTTP_${String(status)}` };
      }
      // 1xx and 3xx: gh follows redirects, so this is not an answer to the request.
      return isRead
        ? { kind: "unavailable", code: `HTTP_${String(status)}` }
        : { kind: "unknown", code: `HTTP_${String(status)}` };
    }
  }

  function noteRateLimit(headers: Readonly<Record<string, string>>): void {
    const remaining = headers["x-ratelimit-remaining"];
    const reset = Number(headers["x-ratelimit-reset"]);
    if (remaining === "0" && Number.isFinite(reset)) {
      exhaustedUntil = reset * 1000 + RESET_MARGIN_MS;
    } else if (remaining !== undefined && remaining !== "0") {
      exhaustedUntil = 0;
    }
  }

  function rateLimitWait(response: HttpResponse, tryIndex: number): number {
    const hinted = retryAfterMs(response.headers, deps.now());
    if (hinted !== undefined) return hinted;
    if (response.headers["x-ratelimit-remaining"] === "0" && exhaustedUntil > 0) {
      return Math.max(exhaustedUntil - deps.now(), 0);
    }
    const spread = backoff(tryIndex);
    return /secondary rate limit/i.test(response.body)
      ? Math.max(spread, SECONDARY_LIMIT_MIN_WAIT_MS)
      : spread;
  }

  async function readPages(
    path: string,
    visit: (page: unknown) => PageVisit,
  ): Promise<PagesResult> {
    let next: string | undefined = path;
    for (let pages = 0; next !== undefined; pages += 1) {
      if (pages >= policy.maxPages) return { kind: "failed", code: "PAGINATION_LIMIT" };
      const result = await request({ method: "GET", path: next });
      if (result.kind === "ok") {
        const verdict = visit(result.json);
        if (verdict === "stop") return { kind: "stopped" };
        if (verdict === "invalid") return { kind: "failed", code: "INVALID_RESPONSE" };
        next = nextPagePath(result.headers["link"]);
        continue;
      }
      return {
        kind: "failed",
        code: result.kind === "rejected" && result.retryable ? "RATE_LIMITED" : result.code,
      };
    }
    return { kind: "complete" };
  }

  return { request, readPages };
}

const INVALID_JSON = Symbol("invalid-json");

function parseJson(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return INVALID_JSON;
  }
}

/** 429, or 403 carrying a rate-limit signal (a Retry-After, an exhausted limit, or its message). */
function isRateLimited(response: HttpResponse): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return (
    response.headers["retry-after"] !== undefined ||
    response.headers["x-ratelimit-remaining"] === "0" ||
    /rate limit/i.test(response.body)
  );
}

/** `Retry-After` as delta-seconds or an HTTP date, in ms from now; `undefined` when absent or bad. */
function retryAfterMs(headers: Readonly<Record<string, string>>, now: number): number | undefined {
  const value = headers["retry-after"];
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(date - now, 0);
}

/**
 * The path and query of the `rel="next"` link. Only path and query are kept, so a link can never
 * redirect later requests to another host.
 */
export function nextPagePath(link: string | undefined): string | undefined {
  if (link === undefined) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;[^,]*\brel="?next"?/.exec(part);
    const target = match?.[1];
    if (target === undefined) continue;
    try {
      const url = new URL(target, "https://api.github.com");
      return `${url.pathname.replace(/^\//, "")}${url.search}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
