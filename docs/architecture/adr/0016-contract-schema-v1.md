# ADR-0016 — Contract schema v1: Zod source, generated JSON Schema, `build` in `check`

- Status: Accepted
- Date: 2026-11-10
- Issue: #9 (OMI-007), epic #8, milestone M1 — Core foundation
- Context documents: `docs/engineering/tech-stack.md` §5; `docs/architecture/architecture.md` §3.2,
  §6; ADR-0011 (toolchain); ADR-0013 (model/effort evidence)

## Decision

1. **Zod 4.6.7** (exact, runtime dependency, application layer only) is the single source of the
   v1 contracts in `src/application/contracts/`: workflow, project config, models config, context
   packet, step result and command. Domain does not import it (dependency-cruiser enforces this).
2. **Every object is strict** (`z.strictObject`): an unknown field is rejected, so a credential or
   a smuggled flag in a command or `models.yaml` fails parsing instead of being dropped. Every
   contract has a `schema_version` / `schemaVersion` literal `1`; another value is rejected.
   Field casing follows architecture.md: snake_case for YAML files, camelCase for JSON
   context/result/command.
3. **Capability and model selection data** (Issue #9 added scope): `capability_profile` is
   `{ min_effort }`; a workflow step names a profile by id; `models.yaml` declares model aliases
   (`executor`, `model`, `supported_efforts`), the profiles, and `verified_models` per profile.
   Effort levels are `low < medium < high < xhigh < max` (the Claude Code `--effort` levels).
   Cross-references (alias and profile exist, a verified alias supports at least the profile's
   minimum effort) are Zod refinements: they are **not** representable in JSON Schema, which
   only carries structure (tech-stack.md §5). Workflow acyclicity is left to the workflow domain
   policy; the contract checks unique step ids and that `needs`/gates reference existing steps.
4. **JSON Schema is generated** by `tools/generate-schemas.ts` through Zod's native
   `z.toJSONSchema` (draft 2020-12) into `schemas/*.v1.schema.json`. The pure rendering
   (`json-schema-catalog.ts`) lives in `src/` so the unit drift test and the tool share it.
   `npm run schemas:generate` writes; `npm run schemas:check` (part of `check`) and a unit test
   fail on drift, a missing file or a stray file.
5. **`tools/register-ts-imports.ts`** is a 15-line `node:module` resolve hook that maps a
   `.js` specifier to `.ts` when the `.js` file does not exist. It lets Node's type stripping run
   a tool that imports `src/`, whose files must use `.js` specifiers (AGENTS.md §3), without
   adding `tsx` or building first.
6. **`schemas/**` is excluded from Prettier** (`format`, `format:check`). Generated output is
   serialised deterministically by the generator and is compared byte-for-byte by
   `schemas:check`; formatting it would make two tools fight over the bytes.
7. **`npm run build` and `schemas:check` join `check` and CI**, as ADR-0011 planned, now that
   `src/` has input. No guard was loosened.

## Dependency check (AGENTS.md §6)

`zod` 4.6.7: MIT license, published 2026-10-12 (at least 14 days old when adopted), pinned
exactly, used only under `src/application/`.

## Generated-file marking and path rules

Each generated schema starts with a `$comment` naming the generator and "do not edit". The
generator emits the `io: "input"` form so defaulted fields are optional. The drift reader
normalises CRLF so a Windows checkout with `autocrlf` does not report false drift. Path
schemas reject `..` segments (also across line breaks), backslashes, line breaks, NUL and a
drive prefix such as `C:/`.

## Consequences

- The command set is the six Coordinator commands in architecture.md §5 (`plan`, `dispatch`,
  `wait`, `status`, `pause`, `resume`). Approval and delivery commands are added by the Issues
  that own them, as a new variant with its own strict object.
- Changing a contract means editing Zod, running `schemas:generate` and committing both.
  Breaking a field means a new schema version, not an edit of v1.
- `project.yaml` v1 holds only what architecture.md §4 names (repo, Project, branches, limits,
  policies); later Issues extend it additively or version it.
- The effort list is an assumption taken from the Claude Code CLI; Codex effort names may differ
  and would need a per-executor list when a Codex adapter exists (OMI-014).
