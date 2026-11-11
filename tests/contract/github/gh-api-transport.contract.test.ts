import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGhApiTransport,
  parseGhApiOutput,
  type GhRunner,
} from "../../../src/infrastructure/github/gh-api-transport.ts";
import {
  TransportError,
  type TransportFailure,
} from "../../../src/infrastructure/github/github-transport.ts";
import { nextPagePath } from "../../../src/infrastructure/github/github-rest-client.ts";

// Hand-written to the documented shape of `gh api --include` (status line, headers, blank line,
// body). They hold no account, token or request id. They were not captured from a live gh run.
const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "../../fixtures/github/gh-api", name), "utf8");

describe("gh api --include output", () => {
  it("parses a created comment: status, lower-cased headers and the JSON body", () => {
    const response = parseGhApiOutput(fixture("comment-created.txt"));
    expect(response).toMatchObject({
      status: 201,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-ratelimit-remaining": "4998",
        "x-ratelimit-reset": "1793000000",
      },
    });
    expect(JSON.parse(response?.body ?? "")).toMatchObject({ id: 1001 });
  });

  it("parses error statuses with their rate-limit headers", () => {
    expect(parseGhApiOutput(fixture("rate-limited.txt"))).toMatchObject({
      status: 429,
      headers: { "retry-after": "42", "x-ratelimit-remaining": "0" },
    });
    expect(parseGhApiOutput(fixture("unprocessable.txt"))?.status).toBe(422);
  });

  it("reads the Link header so pagination can follow it", () => {
    const response = parseGhApiOutput(fixture("comments-page-1.txt"));
    expect(nextPagePath(response?.headers["link"])).toBe(
      "repositories/1/issues/7/comments?per_page=2&page=2",
    );
  });

  it("accepts CRLF line endings, as gh prints them", () => {
    const crlf = "HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 7\r\n\r\n[]\r\n";
    expect(parseGhApiOutput(crlf)).toEqual({
      status: 200,
      headers: { "x-ratelimit-remaining": "7" },
      body: "[]\r\n",
    });
  });

  it("returns undefined for output that is not an HTTP response", () => {
    for (const output of ["", "gh: command not found", '{"id":1}', "HTTP/2.0 OK\n\n{}"]) {
      expect(parseGhApiOutput(output)).toBeUndefined();
    }
  });

  it("joins a repeated header", () => {
    const response = parseGhApiOutput("HTTP/1.1 200 OK\nVary: Accept\nVary: Origin\n\n");
    expect(response?.headers["vary"]).toBe("Accept, Origin");
  });
});

describe("gh api transport", () => {
  const ok = (stdout: string) => ({ code: 0, stdout, timedOut: false });

  it("runs gh without a shell, sending a write body on stdin and never on the command line", async () => {
    const calls: { args: readonly string[]; stdin: string | undefined; timeoutMs: number }[] = [];
    const run: GhRunner = (args, stdin, timeoutMs) => {
      calls.push({ args, stdin, timeoutMs });
      return Promise.resolve(ok(fixture("comment-created.txt")));
    };
    const transport = createGhApiTransport({ run, timeoutMs: 1234 });

    const response = await transport.send({
      method: "POST",
      path: "repos/acme/app/issues/7/comments",
      body: { body: "hello; rm -rf / $(whoami)" },
    });

    expect(response.status).toBe(201);
    expect(calls).toEqual([
      {
        args: [
          "api",
          "--include",
          "-X",
          "POST",
          "repos/acme/app/issues/7/comments",
          "--input",
          "-",
        ],
        stdin: '{"body":"hello; rm -rf / $(whoami)"}',
        timeoutMs: 1234,
      },
    ]);
  });

  it("sends a read without a body or stdin", async () => {
    const calls: { args: readonly string[]; stdin: string | undefined }[] = [];
    const run: GhRunner = (args, stdin) => {
      calls.push({ args, stdin });
      return Promise.resolve(ok(fixture("comments-page-1.txt")));
    };
    await createGhApiTransport({ run }).send({
      method: "GET",
      path: "repos/acme/app/pulls?state=all",
    });
    expect(calls).toEqual([
      {
        args: ["api", "--include", "-X", "GET", "repos/acme/app/pulls?state=all"],
        stdin: undefined,
      },
    ]);
  });

  it("returns an error status that gh printed even though it exited non-zero", async () => {
    const run: GhRunner = () =>
      Promise.resolve({ code: 1, stdout: fixture("unprocessable.txt"), timedOut: false });
    const response = await createGhApiTransport({ run }).send({
      method: "POST",
      path: "x",
      body: {},
    });
    expect(response.status).toBe(422);
  });

  it.each<[string, { code: number; stdout: string; timedOut: boolean }, TransportFailure]>([
    ["a killed process", { code: 124, stdout: "", timedOut: true }, "timeout"],
    [
      "a killed process that already printed a response",
      { code: 0, stdout: "HTTP/2.0 201 Created\n\n{}", timedOut: true },
      "timeout",
    ],
    ["a missing gh", { code: 127, stdout: "", timedOut: false }, "not_installed"],
    ["no login", { code: 4, stdout: "", timedOut: false }, "auth_required"],
    ["a network error", { code: 1, stdout: "", timedOut: false }, "connection"],
    ["output without a status line", { code: 0, stdout: "garbage", timedOut: false }, "connection"],
  ])("reports %s as a transport failure", async (_name, result, failure) => {
    const transport = createGhApiTransport({ run: () => Promise.resolve(result) });
    const error: unknown = await transport
      .send({ method: "POST", path: "x", body: {} })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).failure).toBe(failure);
    // The message is fixed text: it never carries tool output.
    expect((error as TransportError).message).toBe(`GitHub transport failed: ${failure}`);
  });
});

describe("pagination links", () => {
  it("keeps only path and query, so a link cannot redirect requests to another host", () => {
    expect(
      nextPagePath(
        '<https://evil.example/steal?page=2>; rel="next", <https://x/?page=9>; rel="last"',
      ),
    ).toBe("steal?page=2");
  });

  it("finds next among several relations and in any order", () => {
    expect(
      nextPagePath(
        '<https://api.github.com/a?page=1>; rel="prev", <https://api.github.com/a?page=3>; rel="next"',
      ),
    ).toBe("a?page=3");
  });

  it("returns undefined on the last page and for missing or odd headers", () => {
    expect(nextPagePath('<https://api.github.com/a?page=1>; rel="prev"')).toBeUndefined();
    expect(nextPagePath(undefined)).toBeUndefined();
    expect(nextPagePath("")).toBeUndefined();
    expect(nextPagePath('<http://[bad>; rel="next"')).toBeUndefined();
  });
});
