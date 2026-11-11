/**
 * The seam between the retry/pagination logic and the way requests reach GitHub. Production uses
 * `gh api` (gh-api-transport.ts); tests use an in-memory fake GitHub that implements this
 * interface, so no test needs a network.
 */
export type HttpMethod = "GET" | "POST";

export interface HttpRequest {
  readonly method: HttpMethod;
  /** REST path with query, relative to the API root, no leading slash: `repos/acme/app/pulls?state=all`. */
  readonly path: string;
  /** JSON body of a write. */
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  /** Header names lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * No HTTP response arrived. Whether the request reached GitHub is part of the answer:
 * - `timeout`: the call was cut off; a write MAY have been applied.
 * - `connection`: the connection failed or broke; a write MAY have been applied.
 * - `not_installed` / `auth_required`: the tool refused before sending anything.
 */
export type TransportFailure = "timeout" | "connection" | "not_installed" | "auth_required";

export class TransportError extends Error {
  override readonly name = "TransportError";
  readonly failure: TransportFailure;

  constructor(failure: TransportFailure) {
    // Fixed text: tool output may carry account names or hints about credentials.
    super(`GitHub transport failed: ${failure}`);
    this.failure = failure;
  }
}

export interface GithubTransport {
  /** Resolves with every HTTP response, error statuses included; rejects only with TransportError. */
  send(request: HttpRequest): Promise<HttpResponse>;
}
