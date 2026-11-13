# ADR-0036: Repository Coordinator consumes the framework

- Status: Accepted (implementation of the PO direction recorded in OMI-091)
- Date: 2026-11-12
- Partially supersedes ADR-0014's separation and eventual replacement sections.

## Decision

`src/` and `templates/` own shared behaviour and text. Source must never import tooling.
Repository adapters may import the authoritative pure policy through the Node registration
hook, using dynamic imports so plain `node tools/coordinator/flow.ts` continues to work.
These adapters run from an immutable external tooling checkout, managed by the implemented
pin mechanism below. Shared `src/` imports and packaged assets resolve within that checkout,
so a broken work branch cannot change the Coordinator code used to repair it. The checked-in
pin is a full SHA from main, a release tag, or a develop first-parent merge with green CI
`check`. Refresh checks provenance and CI and prepares dependencies before activation.

The actual runtime switch is deferred: repository commands use Project/comment-based delivery
and WSL worker logs, whereas product dispatch/delivery requires runtime-owned run/attempt IDs,
approval records and state. Pointing existing commands at that CLI would fabricate or bypass
those records. Existing command names, arguments and gates therefore remain available until
that migration can preserve them. Each remaining copy needs executable parity coverage; a
missing test or template drift must fail `npm run check`.

## Audit outcomes

The following is the migration inventory, not task status. Repository-specific transport and
presentation may remain; policy belongs in the named framework counterpart.

| Audit concept | Outcome and reason |
| --- | --- |
| Top-level AC / ticking | Tooling parser removed; adapter calls `domain/tasks/acceptance-criteria`. Tooling keeps refusal wording for its map input. |
| AC verdict separators | Tooling uses `domain/delivery/acceptance-review` parser; all four separators supported. |
| VERDICT / REVIEWED_HEAD | Repository abbreviated-head compatibility retained; product requires full SHA. Exact matching of supplied prefix is retained for existing comments; product runtime evidence remains separate. Both use `reviewHeader`; `policy-parity.test.ts` compares valid/invalid canonical comments. |
| Status order | Framework `next-task-policy` owns all eight board statuses; tooling consumes it. |
| Task order / next / promotion | Repository Project-shape adapter retained; ordering and promotion now delegate to `promotion-policy`, and the readiness predicate is shared. |
| Readiness / Plan Key | Tooling readiness removed in favour of `readiness-gate`; generic key syntax is canonical. |
| Issue spec / creation | Shared `issue-spec-policy` and Plan Key allocation; repository GitHub transport retained because product intake has a different port. |
| Complexity / effort | Existing copy retained with exhaustive `effort-policy.test.ts` parity; native model names remain repository configuration. |
| Quota parsing / ranking | Repository collector retained for WSL transport/cache and CLI output; framework policies are canonical. Parity must cover common reading/threshold decisions (`policy-parity.test.ts` covers parsers, all threshold edges, reset, stale, shared-account penalty and ranking). Defaults are read from the framework config schemas. |
| Carried PASS | Repository Git-fact adapter retained; parity with `carried-pass-policy` required. Runtime storage differs; `policy-parity.test.ts` covers valid/invalid Git facts. |
| Log retention | Repository log-name adapter retained; common retention decisions have parity with `log-retention-policy` in `policy-parity.test.ts`; repository-only empty .err/current marker deletion remains transport housekeeping. |
| Linked PR Issue | Tooling calls `domain/delivery/pull-issue-link`. |
| Watch / diagram / rework | Page, server, diagram and rework already consume framework modules (OMI-092); repository board/quota/WSL snapshot adapter retained. |
| Worker report | Repository stream/log reader retained; runtime validates structured output contracts. Repository now validates `stepResultSchema` before accepting output (all four workflow output aliases use it); script ids never create runtime records. `single-source.test.ts` covers rejection/acceptance. |
| Worker permissions | Framework invocation owns the default no-shell policy; repository legacy shell access is an explicit transitional policy difference, limited to source maintenance until runtime checks/commit handle shell work. Allow/deny arrays now have one source in `claude-code-invocation.ts`, with identity parity in `single-source.test.ts`. Runtime default remains no-shell; no approval gate is weakened. |
| Coordinator skills | Framework bridge templates are authoritative. Protected native installation belongs to Coordinator; `source-parity.ts` rejects installed drift and missing registered parity evidence. |
| Worker rules / report / prompt | Packaged `templates/prompts/` owns shared text; repository read-first and restrictions are template assets. |
| Script-first rule | `templates/project/.omi-squad/rules/script-first.md` owns operational guidance; AGENTS §9 adds only repository coordinates and script commands. |

## Gates and scope

Tooling Issues (Area tooling or declared `tools/coordinator/` / `.claude/skills/` paths)
need a nonempty `## Framework counterpart` section naming source/template ownership or a
reason no counterpart applies. Apply the same policy on intake and readiness in both paths.
Issue text is data; a counterpart statement never grants approval.

OMI-093 owns cost/quality policy and Project Workflow routing; do not duplicate it. Independent
QA/review and runtime approval gates remain mandatory. This ADR does not authorize migration
of runtime state or treating a comment as a runtime-owned approval.

## Packaged prompt embedding

Application prompt rendering must remain free of filesystem I/O. `tools/generate-worker-prompts.ts`
embeds the packaged Markdown prompt assets into the generated application service
`worker-prompt-assets.ts`; the generator's `--check` fails on drift. This is a generated
representation, never an independently editable instruction source. It adds no module/layer or
dependency. Repository templates under `templates/bridges/repository/` are the source-maintenance
variant of the bridge, installed with the Coordinator-only skill installer; it intentionally
installs no runtime, config, credentials or native settings into this repository.


## Workflow gap outcomes

- Issue Workflow routing, step effort, cost policy, combined quality packets and Project option
  aliases are already shared by OMI-093. This change preserves them.
- Repo packets select actual template steps, roles, skills and rules; OMI-090 already supplied
  this path. The runtime keeps its documented role-plus-step context resolution; the repo's
  exact-step packet is an explicit adapter rather than a second workflow definition.
- Analyze, verify and review remain fresh worker runs, with native resume refused for those
  steps. No author review or profile separation requirement is introduced.
- All four output-contract names use the framework v1 result schema. Repository worker-report
  rejects invalid/free-text results. Script packet ids are not runtime run/approval records.
- Scope approval is the Coordinator's explicit recorded decision reference supplied with
  `--scope-approved`; Issue/comment prose cannot supply it. Business/cost approval still goes
  to the PO. Migrating this reference to runtime-owned storage is deliberately deferred with
  the runtime-state switch; no fabricated approval is recorded by the adapter.
- Ready-to-merge remains the existing fixed-head flow gate. The 2 + Architect + 2 controller
  remains the documented repository procedure, observed through shared rework policy/watch;
  automatic runtime enforcement waits for the state migration. `/omi-next` retains all steps
  and gates and must stop when they refuse.
- `commit-worker` stages tools and the named managed root files in addition to source, refuses
  dirty in-scope leftovers after staging, and retains branch/index guards. Runtime task-scope
  staging remains the target; the repository's fixed scope is explicitly transitional.

## Evidence inventory

`single-source.test.ts` covers parser/fence, generic keys, Status order, counterpart readiness,
maintenance permissions, result schema and tooling commits. `policy-parity.test.ts` covers
review presentation, carried PASS, retention, quota and Issue-spec/Plan-Key copies;
`effort-policy.test.ts` retains its exhaustive complexity matrix. Existing watch snapshot,
workflow and web tests cover the shared observability adapters. Integration tests exercise the
literal plain-Node flow entry point, skill preview/apply/drift and missing copy evidence.

## Implemented tooling pin (review correction)

The runtime CLI migration above remains deferred, but isolation of the repository tooling is
implemented now. `tools/coordinator/coordinator-pin.json` is the checked-in desired pin (full
SHA, source main/develop/release tag, previous SHA/source). `pin.ts` is the thin bootstrap,
independent of `src/`; `pin-policy.ts` validates records and provenance/CI decisions.
`coordinator-target.ts` holds the existing WSL defaults for both settings and bootstrap, so
overlap checks cover the default target too, without importing potentially broken framework
code. This repository-only bootstrap has no product counterpart: the product installer manages
runtime project packages/state, not the source repository’s temporary Coordinator clone. The seed
is a historical develop merge before the plain-flow regression; no checkout is active until
first-install verifies GitHub provenance, a completed successful `check` from the repository's
`ci.yml` workflow, dependencies and the literal plain-Node flow smoke command.

`node tools/coordinator/pin.ts status|refresh --to <full-sha>|rollback [--dry-run]` manages a
standalone clone at sibling `omi-coordinator-pin/` next to the host checkout. Set the absolute
`OMI_COORDINATOR_PIN_DIR` path to override it. The path cannot overlap the host checkout or the
configured WSL work checkout; symlink aliases are checked. Run from the host working checkout
(or pass `--repo <absolute-host-checkout>`). Refresh defaults to the recorded source; use
`--source main|develop|tag:<release-tag>` to change provenance. Develop candidates must be merge
commits on develop's first-parent history; a release tag must be an actual GitHub release.
All candidates, including rollback, require successful CI `check`; unrelated/foreign workflow
checks, pending, failed, cancelled and absent checks are refused.

Refresh builds a fresh sibling staging clone at exactly the requested SHA, runs
`npm ci --ignore-scripts` and `node tools/coordinator/flow.ts --help`, then replaces the external
checkout by rename while retaining the former checkout for recovery. It never checks out or
builds in the task worktree. An exclusive external lock prevents concurrent pin mutations;
dirty or mismatched existing installations are refused. Failed preparation leaves the active
checkout and tracked pin unchanged. The record is atomically updated only with activation;
activation failure restores the prior checkout. Rollback uses the previous SHA/source and the
same gates, and swaps the two record entries. Run refresh/rollback between Coordinator commands,
not while another command is importing code from the pin. Retained previous checkouts are not
automatically deleted.

Skill installation expands `{{pin_bootstrap}}` from the single packaged
`templates/prompts/coordinator-pin-bootstrap.md` asset. It resolves the verified external path
via the external pin’s own `pin.ts status` into PowerShell `$coordinatorPin`, refusing an uninitialized/dirty/mismatched
checkout. The initial path comes from `OMI_COORDINATOR_PIN_DIR` or the shared default sibling name, rendered by the installer. No moving-source code is loaded by installed skills, even during bootstrap. The installed text is machine-independent, so Windows and CI compare the same bytes. Every
/omi-* mechanical command invokes its flow/status/watch entry point there, from the host work
checkout as the current directory. Packaged prompts, workflows, skills and rules resolve from
the tool's own location; WSL Git/check/dispatch paths still use `OMI_WSL_REPO_DIR`. A pin refresh
therefore changes code without changing the work target or requiring native configuration edits.
The Coordinator re-installs the rendered skills after merging template changes. Only skill
installation writes native skills; pin refresh does not.

First install, after this PR has a green merged develop revision (replace the SHA placeholder):

```text
node tools/coordinator/pin.ts refresh --to <full-green-develop-merge-sha> --source develop --dry-run
node tools/coordinator/pin.ts refresh --to <full-green-develop-merge-sha> --source develop
node tools/coordinator/pin.ts status
node tools/coordinator/skill-installation.ts install --apply
```

After first install, omit `--to` to rematerialize the checked-in pin; its provenance and CI are rechecked. The historical seed predates the self-hosted pin bootstrap and cannot be activated: the first install must select a green merged revision containing this mechanism, as shown above. Missing bootstrap entry points are refused before activation. Status is
read-only and reports an absent checkout as uninitialized, never silently falling back to
moving develop. A failed first install leaves no active checkout. Refresh changes the tracked
record for Coordinator review/commit; it never commits, pushes or changes GitHub state.
