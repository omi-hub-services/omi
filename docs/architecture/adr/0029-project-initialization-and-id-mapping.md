# ADR-0029 — Project initialization, explicit ID mapping and template copy intents

- Status: Accepted
- Date: 2026-11-11
- Issue: #23 (OMI-019)
- Context: architecture.md §3, §4, §11; ADR-0015, ADR-0016, ADR-0020, ADR-0022, ADR-0025

## Decision

`inspectProject` discovers a user or organization Project v2 and reads the complete cursor-paginated
field collection, including single-select option IDs. Display names are metadata only. The caller
selects logical keys and supplies `field_id`, `data_type` and option IDs; initialization verifies
membership and type against the inspected Project. Missing IDs, duplicate mappings, partial
GraphQL responses and incomplete pagination fail closed. No field is renamed or changed.

`project.yaml` v1 gains optional `project.mapping` (`id`, `owner_type`, `fields`). This is additive:
existing v1 configs still validate. Initialization always supplies the mapping when creating a new
config. The generated project-config JSON Schema is updated through the existing generator.

Initialization is a preview unless `apply: true` is supplied. Mapping previews contain a validated
`proposed` config and a deterministic leaf diff (`changes`, with before/after values). Existing
config produces `config-exists`, even with apply, and is never written. Merge proposals preserve
its repository, branches, limits and approval policies. Unselected mappings are preserved only
when the Project node ID is unchanged. Switching Project discards old ID mappings in the proposal.
No automatic config migration or force flag is provided.

The config adapter is pinned to a bootstrap-supplied, existing config directory. It bounds YAML
size, rejects duplicate keys, unresolved/custom tags and alias expansion, validates the contract
and checks for credentials. It refuses symlink/non-regular input. Apply writes a private synced
temporary file, then uses an exclusive hard link to publish `project.yaml`. An existing destination
wins, including a file created after the preview or by another initializer. No truncate/replace
fallback is permitted on a filesystem without hard-link support.

## Template flow

1. Call `initializeProject` with `source.kind: template`, a source Project owner/number, destination
   owner, title, stable `operationKey`, and the caller's config baseline. Preview returns the
   inspected template and concrete `project.copy` intent; it writes nothing. Destination field and
   option IDs do not exist yet, so a config diff is deferred to the mapping stage.
2. Explicit apply pins the payload artifact and atomically queues an audit event plus outbox intent.
   `StateUnitOfWork` gains `outbox_intent` for initialization before a project/run row exists; it
   requires an outbox entry and refuses an existing operation key without appending another event.
   Reusing a key with another payload is refused. An artifact committed before an enqueue failure
   can remain unreferenced; no remote request was sent and normal artifact recovery owns it.
3. The normal runtime `flushOutbox` performs `copyProjectV2`, with `includeDraftIssues: false`,
   through the existing `gh` transport. It retains ADR-0025's persisted in-flight state, unknown
   outcome and reconciliation-before-retry behavior. `project.copy` extends the operation contract.
4. `copyProjectV2` cannot set a body. The copied title therefore ends in the existing logical
   operation marker. Reconciliation scans the destination owner's Projects with cursor pagination
   and matches that complete title, returning `project:<node-id>:<number>`. `clientMutationId` is
   correlation only, never treated as an idempotency key. Keep the marker while the outcome is
   unresolved; editing/removing it can prevent reconciliation, as with Issue body markers.
5. Inspect the copied Project by its destination owner and returned number, choose its **new**
   field/option IDs, and call the existing-mapping path. Preview the config diff, then explicitly
   apply to create config. Source-template field IDs are not reused or guessed from names. A
   subsequent template call with the same key reports the durable queue state and remote identity.

The copy shape follows the [GitHub Projects reference](https://docs.github.com/en/graphql/reference/projects#copyprojectv2).
The transport's POST GraphQL query path is explicitly read-only, so transport failures and HTTP
rate limits reuse the REST client's bounded read retries. Mutations retain conservative write
semantics; GraphQL mutation errors, partial data or missing identities become unknown outcomes.

## Codebase onboarding (OMI-033)

`initializeProject` gains `source.kind: codebase` with `variant: new | existing`; no parallel use
case. It detects the stack from root marker files only (`detectCodebase`: language, package
manager, test/build/lint commands; evidence-based, `unknown` when nothing matches, nothing is
executed) and targets four files: `project.yaml` (existing config store), the variant's workflow
from `templates/project/workflows/`, `.omi-squad/config/codebase.yaml` and
`.omi-squad/config/onboarding-plan.md`. Preview is the default and writes nothing; every target
is reported as `would-create`, `created` or `kept`. An existing target (including a symlink or a
file that appears after the preview) is kept and never replaced; a symlinked parent directory is
refused. Workflow templates are parsed and validated against the workflow contract before use.
Commands taken from repository text are dropped if they look like credentials. No dependency,
module directory or CLI command is added.

## Scope and validation

No dependency, module directory, migration, guard exception or native tool configuration is added.
Tests use synthetic GitHub responses and temporary config/SQLite/artifact directories. They prove
org/user discovery, pagination, ID mapping, dry-run, preservation of existing bytes, concurrent
publication, template copy and timeout-after-success recovery across a SQLite restart.

CLI wiring is deferred: ADR-0020 requires a versioned command, dispatcher branch, presenter and
bootstrap lifecycle for the config/outbox stores. The exposed use cases and adapters are ready for
that follow-up. No `omi init` command is claimed here. Live template copy, permissions/token scopes,
and filesystem behavior outside the WSL/Linux baseline remain unverified by these offline tests.
