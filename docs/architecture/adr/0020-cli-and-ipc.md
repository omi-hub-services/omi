# ADR-0020 — CLI (Commander) and versioned local IPC skeleton

- Status: Accepted
- Date: 2026-11-10
- Issue: #13 (OMI-011), epic #8, milestone M1 — Core foundation
- Context documents: `docs/engineering/tech-stack.md` §3 (CLI row), §7 (IPC and timeout);
  `docs/architecture/architecture.md` §3.3, §3.4, §5, §13; ADR-0011 (toolchain); ADR-0016
  (command contract); ADR-0018 (SQLite is written only by the runtime)

## Decision

### 1. Commander, interfaces layer only

`commander` **15.0.0** is a runtime dependency used only under `src/interfaces/cli/`
(pinned exactly, added in commit `1b5b978`). Handlers parse arguments, build a v1 `Command`
(ADR-0016), send it through the IPC client and hand the outcome to a presenter. They hold no
business rule and cannot reach state: dependency-cruiser forbids `interfaces` → `infrastructure`
and `interfaces` → SQL driver (see §5). Wiring (real IPC client, socket path, process I/O) is in
`src/bootstrap/cli.ts` and `src/bootstrap/container.ts`.

Dependency check (AGENTS.md §6): MIT license, no transitive dependencies, exact pin, interfaces
layer only. `zod` (already pinned by ADR-0016) is also imported by `src/interfaces/ipc/` to
validate the IPC envelope at the boundary; this adds no dependency, but it is the first use of
Zod outside `application/` and is listed as an open decision for the Architect.

### 2. IPC protocol v1 (`src/interfaces/ipc/protocol.ts`)

- **Transport**: Unix domain socket (`node:net`), local only, no HTTP. Default path
  `<project>/.omi-squad/local/ipc/runtime.sock` (architecture.md §4); override with
  `OMI_SQUAD_SOCKET` or `--socket`.
- **Framing**: 4-byte big-endian unsigned payload length, then that many bytes of UTF-8 JSON.
  One request frame gets exactly one response frame, in order, per connection.
- **Payload limit**: `MAX_PAYLOAD_BYTES` = 1 MiB (1,048,576), both directions. A length header
  above the limit is rejected **without reading the payload**; the server answers
  `PAYLOAD_TOO_LARGE` and closes that connection, because the stream can no longer be aligned.
  A payload of exactly the limit is accepted.
- **Request**: `{ "protocolVersion": 1, "requestId": "<[A-Za-z0-9._-]{1,64}>", "command": <ADR-0016 command> }`.
  The envelope is a strict object; `command` is validated with the v1 command contract.
- **Response**: `{ "protocolVersion": 1, "requestId": <id|null>, "ok": true, "result": … }` or
  `{ …, "ok": false, "error": { "code", "message" } }`. `requestId` is `null` only when the
  request was too broken to read an id from. The client rejects a response whose id does not
  match its request.
- **Version**: any `protocolVersion` other than 1 gets `UNSUPPORTED_VERSION`. A breaking change
  means a new version number, not an edit of v1.
- **Robustness**: invalid JSON, non-object JSON, invalid UTF-8, unknown envelope fields and
  invalid commands each get a typed error and the connection stays usable (except oversized).
  Requests on one connection are handled one at a time (the socket is paused meanwhile), an idle
  or half-sent connection is destroyed after 30 s, at most 32 connections are accepted, and a
  handler exception becomes a fixed `INTERNAL_ERROR` message (the cause is never sent).
- **Permissions**: the socket's directory must be owned by the current user and not accessible to
  group/others (created `0700`; an existing looser directory is refused, never chmod-ed), and
  the socket file is `0600`. A leftover socket is removed only if nothing answers on it; a live
  one or a non-socket file makes `start()` fail. This limits access to the same user; it is not
  a sandbox against processes of that user (tech-stack.md §7).

Error codes (stable; a code is never reused or renamed):

| Code                  | Origin  | Meaning                                                          |
| --------------------- | ------- | ---------------------------------------------------------------- |
| `PAYLOAD_TOO_LARGE`   | runtime | Length header above the limit; connection closed                 |
| `MALFORMED_REQUEST`   | runtime | Not JSON/UTF-8, not an object, bad envelope or request id        |
| `UNSUPPORTED_VERSION` | runtime | `protocolVersion` is a number other than 1                       |
| `INVALID_COMMAND`     | runtime | Envelope is fine, `command` fails the v1 contract                |
| `NOT_IMPLEMENTED`     | runtime | Valid command whose use case does not exist yet                  |
| `APPROVAL_REFUSED`    | runtime | Approval use case refused the request; message gives the reason |
| `COMMAND_REFUSED`     | runtime | A run command (`plan`, `dispatch`, `deliver`, …) was refused by its use case or gate; message is `REASON[: detail]` (added by OMI-030; additive, protocol stays 1) |
| `INTERNAL_ERROR`      | runtime | The handler failed; no detail is sent                            |
| `RUNTIME_UNAVAILABLE` | client  | Nothing listens on the socket (ENOENT, ECONNREFUSED, EACCES, …)  |
| `TIMEOUT`             | client  | No complete response before the deadline (default 5 s)           |
| `PROTOCOL_ERROR`      | client  | Bad frame/JSON/shape, wrong request id, hang-up without an answer |

### 3. Exit codes (`src/interfaces/cli/presenters/exit-codes.ts`)

| Exit | Name                  | When                                                                 |
| ---- | --------------------- | -------------------------------------------------------------------- |
| 0    | `OK`                  | The command ran and the runtime accepted it (not "task accepted")    |
| 1    | `FAILURE`             | Unexpected CLI failure, or `INTERNAL_ERROR` from the runtime         |
| 2    | `USAGE`               | Bad arguments, unknown command/option, missing command               |
| 3    | `RUNTIME_UNAVAILABLE` | `RUNTIME_UNAVAILABLE` or `TIMEOUT`                                   |
| 4    | `REQUEST_REJECTED`    | `PAYLOAD_TOO_LARGE`, `MALFORMED_REQUEST`, `UNSUPPORTED_VERSION`, `INVALID_COMMAND`, `NOT_IMPLEMENTED`, `APPROVAL_REFUSED`, `COMMAND_REFUSED` |
| 5    | `PROTOCOL_ERROR`      | `PROTOCOL_ERROR`                                                     |

Numbers are never reused or renumbered, only added. The mapping from IPC code to exit code is
an exhaustive `Record`, so a new IPC error code does not compile until it has an exit code.

### 4. Output

Text is the default for the PO: success on stdout, errors on stderr as `error[CODE]: message`
(control characters in the message are replaced, so a peer cannot drive the terminal). With
`--json` the CLI prints exactly one document on stdout for success **and** failure:
`{ "schemaVersion": 1, "ok": true, "exitCode": 0, "result": … }` or
`{ …, "ok": false, "exitCode": n, "error": { "code", "message" } }`; usage errors use
`code: "USAGE"`. The runtime's result is validated again by the presenter before it is shown.

### 5. Skeleton scope and the architecture guard

Only `status` is wired end to end: CLI → IPC client → server → `createCommandDispatcher` →
`inspectRuntime` use case (`src/application/use-cases/project/inspect-runtime.ts`, contract
`runtime-status.ts`). The other five v1 commands validate but answer `NOT_IMPLEMENTED`; each
later Issue replaces its stub. The runtime process lifecycle is OMI-016.

AC-3 is enforced by `npm run check:architecture`. The rule `interfaces-not-to-infrastructure`
already forbade importing adapters. While adding the fixture proving it, the rule
`interfaces-no-sql-github-spawn` (and `application-no-io-libraries`) turned out not to match npm
packages at all: dependency-cruiser matches `to.path` against the resolved file
(`node_modules/better-sqlite3/…`), not the import specifier, so the anchored `^better-sqlite3`
never matched. The patterns now match the resolved `node_modules/<package>/` path. This
**tightens** the guard; the new fixture `invalid-imports/src/interfaces/cli/commands/state-commands.ts`
proves an interfaces file can reach neither the SQLite adapter nor the SQL driver.

## Consequences

- Adding a command: add a `register…Command` under `src/interfaces/cli/commands/`, a use case,
  a dispatcher branch, and tests; the IPC protocol does not change.
- Adding a protocol field or error code that changes meaning means a new `PROTOCOL_VERSION`.
- The JSON output document and `runtime-status` contract are not yet in the generated JSON Schema
  catalog (`schemas/`); that is a follow-up once more commands exist.
- Only same-user access control is provided; there is no authentication of the peer beyond
  filesystem permissions.
