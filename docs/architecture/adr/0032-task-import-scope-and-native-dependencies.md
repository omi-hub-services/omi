# ADR-0032 — Task snapshots, explicit scope and native dependencies

- Status: Accepted
- Date: 2026-11-11
- Issue: #24 (OMI-020)
- Context: architecture.md §3, §8–§9; ADR-0016, ADR-0017, ADR-0018, ADR-0025, ADR-0029

## Decision

`importTask` reads a scope from a configured Project v2 node ID and repository identity. A scope
is exactly one milestone node ID, an iteration **field ID plus iteration ID**, or an explicit list
of Issue node IDs. Names and Issue numbers are display metadata, never identifiers. The caller
uses OMI-019's inspected/mapped Project IDs; no fields or names are guessed. Explicit lists select
Issues that are members of that Project, not arbitrary repository Issues. An empty list selects
nothing. A missing/nonmatching list member is excluded; scope is never silently broadened.

Minimum import eligibility is deliberately mechanical: a real Issue, an unarchived Project item,
the configured repository (case-insensitive owner/name), OPEN state, and nonblank title and body.
DraftIssue, PullRequest, redacted/deleted content, archived items, closed Issues and blank content
are excluded as task candidates. These checks do not establish semantic Definition of Ready:
objective/AC quality, role/workflow choice, business approval and cost approval remain separate
Coordinator/workflow gates. Issue bodies remain opaque data and cannot grant an approval or add a
native dependency. No Issue-body parsing convention is introduced.

For each candidate, import follows the complete native `Issue.blockedBy` transitive closure,
including predecessors outside scope, outside the Project or repository, or closed/otherwise
ineligible as candidates. These snapshots are dependency evidence only. Missing/inaccessible
predecessors fail the import rather than disappearing from the graph. Existing
`validateTaskDependencies` / `findDependencyCycle` validate the complete closure before any result
is returned. Refusals retain the domain diagnostics, including a cycle path. The read is bounded
to 1,000 distinct Issues (including Issues inspected for milestone matching) and 20 pages per
connection by default; exceeding either bound fails, never truncates.

A v1 snapshot contains the validated Issue ID/number, repository, title, body, state,
remote updated time, milestone ID and native blocked-by IDs. Its `contentHash` is SHA-256 over
UTF-8 `JSON.stringify({ schemaVersion: 1, issue })` in Zod schema field order. Blocked-by IDs are
sorted and deduplicated as a set. Scope, Project iteration values and runtime task state are
separate from Issue content and do not affect this hash. Neither capture time nor generated IDs
enter the hash. Hashing goes through a pure `ContentHasher` port with a Node crypto adapter in
the existing artifacts module; no dependency is added. Changes to any captured Issue field change
the hash; key order, dependency order and scope changes alone do not. Noncaptured GitHub data,
such as comments/reactions, is outside this snapshot contract.

`selectReadyTasks` revalidates the graph and checks current scope, repository, Project membership
and import eligibility on every call. Only pending/ready tasks with all predecessors in verified
runtime `done` state can be returned. Missing runtime state means pending; closed Issue state is
never inferred to be Done. Caller-provided runtime states must come from trusted runtime storage,
not Issue text. No state is transitioned or persisted by these read-only use cases. Dependency-only
snapshots never expand scope; a closed predecessor can satisfy a dependency only through an
independently established runtime Done state (ADR-0017).

## Adapter and completeness

`GithubTaskReader` uses the existing retrying read-only GraphQL path over `gh` transport. Project
items, each active Issue item's field values, and native blocked-by connections are separately
cursor-paginated. Null Issue/dependency nodes, malformed payloads, GraphQL errors alongside data,
identity mismatches, missing/repeated cursors, count mismatches and page limits refuse the read.
Redacted Project item content is explicitly excluded. Issue metadata must remain identical across
its dependency pages; changing collection counts also refuse the read. Reads do not provide a
GitHub-wide transactional snapshot: equal-count membership changes during pagination may evade
detection. Reimport before dispatch when freshness matters.

The API shapes follow GitHub's [Issue reference](https://docs.github.com/en/graphql/reference/issues)
and [Projects reference](https://docs.github.com/en/graphql/reference/projects). Contract tests use
synthetic, secret-free wire fixtures, not recorded live credentials or live GitHub writes.

## Consequences and limits

The output is a validated in-memory import batch: scope, Project item metadata, snapshots and
native edges. It can be passed directly to selection; durable storage and CLI/IPC command wiring
are not introduced by this task. Existing SQLite tables are untouched; migration 0006 is unused.
A later persistence use case must coordinate snapshot/edge/artifact writes with audit events via
the runtime transaction boundary, and preserve immutable run inputs. GitHub remains authoritative;
no status/progress is mirrored into source files. No remote writes or outbox intents are produced.

Unit and offline contract tests cover stable hashes/content edits, all three scopes, exclusions,
cross-scope dependency evidence, cycle refusal, selection/runtime states and complete/failing
pagination through the existing gh stdin transport. Live permissions, remote concurrent edits,
CLI wiring and durable snapshot recovery are unverified here. Independent review on a fixed
revision remains the Coordinator's separate gate.
