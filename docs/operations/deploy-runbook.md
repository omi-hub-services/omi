# Sandbox deployment and approved rollback

The runtime writer calls `deployRelease` with a repository, environment, immutable
`sha256:<64 lowercase hex>` artifact digest and durable deploy approval ID. Release approval
is insufficient. The configured agent account dispatches; an allowlisted PO approves the
native environment gate. Configure required **User** reviewers, `prevent_self_review: true`
and `can_admins_bypass: false`. Teams and bypass are refused by this adapter.

Install `tests/fixtures/github/sandbox-deploy.yml` as `.github/workflows/<workflow>` in the
sandbox only, review its commit and create a protected lightweight tag for it. Configure
`pipeline.workflow`, `ref` (that tag), `workflowSha` (reviewed commit), `issueNumber` (PO report
Issue), `allowedActors` (PO logins), and `authorActor` (dispatch credential login). Tag movement
is refused before dispatch; run SHA is checked again during verification. The workflow must
also exist on the default branch for Actions dispatch. Set repository variable
`OMI_SANDBOX_IMAGE` to a reviewed container image repository whose chosen digest stays running.
The sample pulls and starts that digest without network access, verifies it, and removes the
disposable container. It never deploys production or changes environment protection.

The workflow contract is `run-name: omi-deploy:<operation_key>`, inputs `operation_key`,
`environment`, `artifact_digest`; its job targets the input environment. It creates a deployment
whose payload contains `operation_key`, `artifact_digest`, numeric `run_id` and whose SHA is the
workflow commit. The reader requires matching run/repository/actor/workflow/SHA/first attempt,
PO native approval for that environment, exact digest and latest deployment status. Unrelated
native Actions deployment records are ignored. A green run alone is insufficient.

Outbox keys hash the ordered intent tuple
`[repository, environment, artifactDigest, approvalId, rollback?.runbookRef, rollback?.approvalId]`
(absent rollback fields serialize as `null`). An approval is one intent: repeating that request
reconciles the same run, while a fresh deploy approval creates a new dispatch, including after a
failed deployment or when deploying A again after B. Keep a single
runtime writer and the same state/artifact directory on restart. A timeout or lost response
never causes redispatch: the adapter reconciles run listings; absence remains unknown even
after the usual grace period. Retain runs and deployments until reconciliation completes.
An unresolved dispatch needs PO investigation; do not request a new approval simply to bypass
an unknown outcome. A same-title run by another actor makes lookup unavailable; inspect it with
the PO, since the adapter fails closed and never adopts it or dispatches around it.
Changing pipeline configuration for an existing intent is a key conflict. A polling budget or
unavailable read returns pending; it neither cancels the run nor starts rollback. OMI-071 wakes
only resource-starved worker steps and does not resume deploy verification. A nonterminal run
triggers one deduplicated PO comment after ten minutes from the durable intent's creation, or
earlier if the polling budget ends. The waiting notice has a separate outbox key from a later
failure report. The pending result reports notification delivery state; retain state and resume
with the same request after the PO investigates. Failed,
cancelled or timed-out terminal runs produce a failed outcome, append evidence to runtime audit
and send a deduplicated `issue.comment` mentioning the PO. Inspect `notification` for pending
or failed delivery and call again to reconcile/report. Runtime audit holds the run ID,
conclusion, deployment ID/status, digest and native approval result.

Rollback is an explicitly requested, separate deploy of the previous digest, with its own
current deploy approval. There is no automatic rollback. Pass
`rollback: { runbookRef: "rollback-sandbox-r1", approvalId: "<runbook approval ID>" }`.
The trusted workflow's `RollbackRunbookReader` resolves that identifier to a reviewed record:

```json
{
  "reference": "rollback-sandbox-r1",
  "revisionHash": "<64 lowercase hex SHA-256 of the reviewed runbook revision>",
  "repository": "owner/sandbox-repo",
  "environment": "sandbox",
  "previousDigest": "sha256:<64 lowercase hex>"
}
```

The reviewed runbook includes the restoration steps, verification criteria and stop/report
conditions. Authenticate a separate **business** approval through the existing approval
lifecycle, with `baselineHash = revisionHash` and `scopeIds = [reference]`. The runtime reads
this approval from `ApprovalStore`; a reference or JSON `approved: true` is insufficient.
Changing the revision, repository, environment or previous digest invalidates rollback.
A rollback intent pins its runbook reference and revision in the durable payload. Deploy A,
deploy B, then rollback to A uses a fresh deploy approval and an approved runbook; it dispatches
a new run and verifies that run's deployment, rather than reusing the first A deployment.
Repeating the same rollback request reuses its intent, including across restart or lost response.
Changing the runbook reference or its approval ID also identifies a separate rollback intent.

The opt-in live test reads `OMI_LIVE_DEPLOY_CONFIG`, a JSON file containing `request`, `pipeline`,
`stateDirectory` and optional `runbooks` (records above). Prepare a dedicated migrated state database
and artifacts directory (runtime layout, see `local-state` below) with approvals authenticated through the existing lifecycle. The test
does not import decisions from JSON. It dispatches only to a sandbox-named repository and
writes evidence under `.tmp/live/omi-041-deploy-evidence.json`. It waits up to ten minutes for
the PO's native approval. If dispatch is still unconfirmed, retain state and rerun to reconcile.
Default checks do not run it. The PO chooses sandbox repository, workflow/tag/SHA, protected
environment, image/digest, PO/report Issue and the time to run the probe.

## Preparing the sandbox for the live run (OMI-089)

`tools/sandbox-setup/` prepares `omi-hub-services/omi-sandbox` and the local state. It never
creates or decides an approval, and it refuses any repository whose name lacks `sandbox` and the
production repository. Run it as the dispatch account (`minibox-claude-code`, repository admin)
after the PO has confirmed the admin changes. The PO supplies the reviewed image repository and
its immutable digest (`sha256:<64 hex>`); the script does not choose or pull one.

```sh
node --import ./tools/register-ts-imports.ts tools/sandbox-setup/main.ts github --image <repo> --digest sha256:<hex> --dry-run
node --import ./tools/register-ts-imports.ts tools/sandbox-setup/main.ts github --image <repo> --digest sha256:<hex>
node --import ./tools/register-ts-imports.ts tools/sandbox-setup/main.ts github --image <repo> --digest sha256:<hex> --verify
```

`--dry-run` reads (GET only) and prints every call it would make: method, path, body summary.
The real run executes exactly that list in dependency order, then re-reads up to five times,
three seconds apart, because GitHub reads can lag right after writes; a second run plans
nothing. If it still exits 1 after every step printed `done`, it lists the ids that were not
seen: that is read lag until proven otherwise. Do not re-run the apply; run `--verify` (and
`--dry-run`, which must plan 0 calls). Exit 1 from `--verify` is the real failure.
`--verify` reads every object back, compares the effective rules on `main` by parsed
parameters, and exits 1 if anything is missing or weaker. A workflow file or tag that exists
but differs is a blocker, never overwritten or moved.

The bootstrap commits the deploy workflow to `main` and tags that commit **before** the
rulesets exist, so no ruleset or native review covers it. The PO reviews that commit (and the
tag's target) before the live run; later changes to the workflow need a reviewed PR.
`OMI_SANDBOX_IMAGE_DIGEST` is only a record of the chosen digest. The controls are the dispatch
input `artifact_digest` and the deploy approval bound to it; a changed variable alone approves
or deploys nothing.

Created, in order: branch `develop`; the deploy workflow (fixture `sandbox-deploy.yml`) and a
lightweight tag `sandbox-deploy-r1` at its commit; the `sandbox-check` workflow (the named
check); repository variables `OMI_SANDBOX_IMAGE` and `OMI_SANDBOX_IMAGE_DIGEST`; environment
`sandbox` (required User reviewer `ttin-omihub`, `prevent_self_review`, `can_admins_bypass:
false`); rulesets `omi-sandbox-main` (1 native approval, stale approvals dismissed, check
`sandbox-check`), `omi-sandbox-develop` (PR, 0 approvals, same check) and `omi-sandbox-tags`
(`sandbox-deploy-*` cannot be deleted or moved), all without bypass actors; and the pipeline/report
Issue (found again by its marker). The PO reviews the workflow commit before the live run.

Local state, outside this repository:

```sh
node --import ./tools/register-ts-imports.ts tools/sandbox-setup/main.ts local-state --state-dir <dir> --image <repo> --digest sha256:<hex>
```

treats `<dir>` as the runtime's project directory and creates, where the runtime reads them,
`<dir>/.omi-squad/local/state/state.sqlite` (migrated, with the project row),
`<dir>/.omi-squad/config/project.yaml` and `<dir>/.omi-squad/local/runs/` (artifacts). It is
repeatable. A directory from an earlier version, with `project.yaml`, `state.db` (+ `-wal`,
`-shm`) and `artifacts/` at the top level, is moved into that layout by this command; `--dry-run`
lists the moves first, and the command refuses, moving nothing, when both layouts exist. Stop any
process using the old `state.db` before it runs.
`--dry-run` lists what it would create without writing anything; `--verify` exits 1 while
anything is missing. The directory must resolve (through symlinks) to outside this repository.
Add `--deploy-approval-id <id>` once the deploy approval exists to write `deploy-config.json`
(`request`, `pipeline`, `stateDirectory`; no credential, no decision) for
`OMI_LIVE_DEPLOY_CONFIG`.

**Approvals are the PO's.** Requests are created through the running runtime, never by this
script: `approvals request <subject-id> --kind business|deploy` creates a pending request and
prints its id and version. It takes no decision flag. The PO records the decision with
`approvals decide <request-id> --expected-version 0 --decision approved --github-comment <id>`
(handbook, approvals). Nothing here, and no agent, fills in a decision.

Subjects come only from trusted records (ADR-0037), never from the caller:

- **business**: the subject id is the local task id `task-<Issue number>` of an imported task, and
  the approval baseline is that snapshot's `content_hash` (the reviewed Issue content), scope = that
  task. Import must run **before** the runtime session starts, because only the runtime holds the
  state lease: call `importTask` then `storeTaskSnapshots` (`src/application/use-cases/tasks/`)
  in-process against the migrated `state.db`, then start the session. There is no import IPC or CLI.
  Re-running is idempotent; a changed Issue stores a new `content_hash` and makes older requests stale.
- **deploy**: the subject id is the `id` of an entry in `project.yaml` `deploy_targets`
  (`{id, target_environment, artifact_digest}`). Each release edits that entry and restarts the session;
  a different digest or environment is a different subject hash, so an approval for the old one
  is refused as `STALE_REVISION`.

The rollback runbook's business approval above (`baselineHash = revisionHash`, `scopeIds =
[reference]`) is a different subject and has no request command yet; it is not part of OMI-095.

## Reconciliation boundary (2026-11-13)

The built CLI exposes `approvals request` and `approvals decide`; it has no deploy, release,
rollback or import command in v0.1. Deployment above is the application/live-test integration,
not a CLI recipe. [CLI verification](cli-verification.md) records help checks only for those
approval pathways; no live request, decision, GitHub write or deploy was run in this audit.
`tools/sandbox-setup/main.ts` exposes `github`, `local-state` and `live-prep` (repository
tooling, below); the import is in-process (`importTask` + `storeTaskSnapshots`), not a product
CLI command. Sandbox setup is repository tooling; its GitHub/admin
operations require the separate authorization above.

## Full lifecycle acceptance (OMI-042, build now / run live later)

`tests/e2e/full-lifecycle.test.ts` runs offline against FakeGithub and fake workers. It chains
business-baseline approval, Issue creation, dispatch/result validation, task PR preparation,
merge/AC completion into develop, release Issue/PR preparation, native release approval,
head-pinned merge, tag/notes, dispatch and native deployment verification. It proves that a
release approval cannot authorize deploy, that a deploy approval cannot authorize release,
and that changed digest/environment or release head cannot reuse the approval.

The opt-in harness is `tests/live/github/full-lifecycle.test.ts`. **Do not run it as part of
normal checks.** Set `OMI_LIVE_LIFECYCLE_CONFIG` to an absolute sandbox JSON path in the test
process environment, then run `npx vitest run tests/live/github/full-lifecycle.test.ts` from
this worktree. Unset means skipped; an empty or invalid setting fails. No PO credential is
accepted: the authenticated GitHub login must match `pipeline.authorActor`, and must differ
from `ttin-omihub`. The guard allows only `omi-hub-services/omi-sandbox` and never posts reviews,
environment approvals or protection changes. It consumes real GitHub quota when enabled.

Operational notes from the 2026-11-13 live run (OMI-098):

- Rebuild `dist/` (`npm run build`) before starting the runtime; a stale build runs old code.
- The state dir must be a git checkout of the sandbox repository (clone it), with `.omi-squad/`,
  the live config and the review file listed in `.git/info/exclude`.
- The runtime needs one heartbeat line on stdin at least every 10 seconds; keeping stdin open is
  not enough.
- Sandbox `develop` must contain the workflows from `main`: the `github` step creates `develop`
  before committing workflows.
- Post the PO decision comment on the pipeline Issue, never on the task Issue (that changes the
  business baseline).
- Run `live-prep` and the harness as the agent account: `authorActor` comes from the logged-in
  `gh` account.
- The release gate reads branch rulesets (approvals, required checks, `update`/`lock_branch`
  rules) and merges them with classic protection when it exists. A classic-protection 404 counts
  as "none" only when rulesets were read; if nothing is readable the gate refuses.

Prepare the dedicated state and the harness config with `live-prep` (never credentials):

```sh
node --import ./tools/register-ts-imports.ts tools/sandbox-setup/main.ts live-prep \
  --state-dir <dir> --acceptance-id <id> --issue <task Issue number> \
  --image <repo> --digest sha256:<hex> [--dry-run]
```

Run `local-state` (previous section) first: `live-prep` refuses unless the directory is outside
this repository, migrated, and has the project row, and it needs the `github` step's pipeline
Issue and tag. The task Issue must exist in `omi-hub-services/omi-sandbox` and be an item of the
sandbox Project. `live-prep` refuses any repository other than `omi-hub-services/omi-sandbox`
(even with `--repo`), and its transport allows only one `GET` of a sandbox Issue and GraphQL
queries. It then, idempotently:

1. imports the Issue with `importTask` and `storeTaskSnapshots` into the runtime state database (task id
   `task-<n>`; the business baseline is the snapshot `content_hash`),
2. adds `deploy_targets` entry `sandbox-<acceptance-id>` (`sandbox`, the digest) to `project.yaml`,
   keeping other entries, and
3. writes `<dir>/live-lifecycle-config.json` (mode 0600) with every known fact and the sandbox
   pipeline block, and lists the fields still to fill. A rerun keeps what you filled in.

`--dry-run` reads GitHub and prints the plan, writing nothing. `live-prep` never creates, records or
simulates an approval. It then prints the next steps; the approval ids come from the runtime:

1. Start the runtime with `<dir>` as its project directory: it finds the config and state that
   `local-state` and `live-prep` wrote. The preparation order is `github` → `local-state` →
   `live-prep` → `local-state --verify` → runtime start. `local-state` uses framework onboarding
   in-process to install missing models, roles, rules, skills/provenance and workflows, preserving
   existing files. Both preparation steps synchronize the project row's `config_hash` with the
   runtime function after config changes. `local-state --dry-run` and `--verify` list missing
   catalogs and hash drift without writing; rerun apply to repair drift before starting.
   The packaged models catalog is empty: configure and verify model capabilities before dispatch.
   From the built framework checkout, start the runtime in a foreground terminal (keep stdin open):

   ```sh
   node dist/bootstrap/runtime.js <dir>
   ```

   Wait for `ready` before issuing approval commands. This starts only the dedicated sandbox;
   never pass the framework source directory.
2. `omi approvals request task-<n> --kind business` and
   `omi approvals request sandbox-<acceptance-id> --kind deploy` print the request ids.
3. As **ttin-omihub**, comment the decision on the sandbox pipeline Issue, then record it with
   `approvals decide <request-id> --expected-version 0 --decision approved --github-comment <id>`.
4. Rerun `live-prep` with `--business-approval-id <id> --deploy-approval-id <id>`. It checks that
   each id exists with exactly the prepared subject (and reports its status) before writing it.
5. Fill the remaining placeholders by hand: `head` (pushed sandbox task branch from `develop`
   with green `sandbox-check`), `evidence` (one reference per top-level AC) and `reviewFile` (an
   actual independent review). Creating that branch is not automated.

The imported Issue only provides the business baseline: the harness opens its own new task Issue
from `idea` and `issueBody`, so the sandbox repository ends up with two Issues for one acceptance.

`acceptanceId` identifies the durable Issue creation intent and evidence file; use a unique value
for a fresh acceptance, and never change the meaning of an existing intent. `reviewFile` must be
an actual independent worker result exported as the validated
`mergeEvidenceSchema` shape: `review` (`reviewerRunId`, `reviewerAgentId`, `headSha`, `baseSha`,
`verdict`, `body` with one `AC-n: met` line per criterion), `authorRunIds`, `authorAgentIds`,
`unresolvedMandatoryFindings`, `workflowGatesPassed`. Do not invent review evidence or decisions.
The harness uses the application task-completion port in memory; it is a use-case acceptance
harness, not proof of a complete CLI installation or GitHub Project synchronization.

Before starting, prepare the sandbox with `tools/sandbox-setup/` (previous section), which applies ADR-0015:
no bypass, native review required on main, named checks, and a protected `sandbox` environment
with required User reviewer `ttin-omihub`, prevent self-review, no admin bypass. Prepare the
reviewed workflow/tag/image as described above. The operator must verify that the immutable
image digest represents the intended task/release; there is no build-artifact provenance port
linking a Git commit to a container digest yet. Existing unrelated develop changes can enter
the release task list: inspect and isolate the sandbox before acceptance.

The PO must also supply **real** business and deploy decisions, requested and recorded as
described above through `approvals request` and `approvals decide` with the trusted GitHub-comment
decision source. Business subject is `{kind:"business", baselineHash, scopeIds:[taskId]}`; deploy
subject is `{kind:"deploy", artifactDigest, environment:"sandbox"}`. A JSON config field or
database edit is not authentication. These durable decisions are additional to the two native
GitHub gates; the harness never creates approvals itself.

The live order and PO actions are:

1. Agent reads the business decision and independent worker evidence; creates the task Issue,
   task PR and backlink; merges through `mergeTaskPr`, ticks AC and closes the task Issue.
   If checks/review refuse this, stop and inspect; the harness does not bypass them.
2. Agent opens the Release Issue and `develop` → `main` PR. The console prints
   `waiting for PO approval at release: <PR URL>`. As **ttin-omihub**, open that URL, inspect
   the Release Issue/task list, exact head and checks, then **Files changed → Review changes →
   Approve → Submit review**. A review of another head does not count.
3. Harness reads the native review and restrictions, performs a merge pinned to that head,
   then publishes the tag and release notes at the confirmed main merge commit.
4. Agent dispatches the approved digest to `sandbox`. The console prints
   `waiting for PO approval at deploy: <Actions URL>` and, once found, the exact run URL.
   As **ttin-omihub**, open the run, select **Review deployments**, select **sandbox**, inspect
   the digest/intent, then **Approve and deploy**. Release approval alone never passes this gate.
   The agent reads native run approvals and digest-bound deployment status; green Actions alone
   cannot complete acceptance.

Each gate has a bounded `timeoutSeconds` budget (30–1800, default 600), polled every five
seconds. Timeout does not approve, cancel, rollback or blindly redispatch anything. Evidence
is saved after stages and on failure to `.tmp/live/omi-042-<acceptanceId>.json`; durable outbox,
approvals, payloads and audit remain in the dedicated state directory. Preserve both on failure.
Rerunning after a stop (OMI-099): keep the same config, state directory and review file, and run the
same command again. If the task's mapped PR is already merged into `develop` on the `review.headSha`
(merge commit on `develop`, read back from GitHub), the harness skips `preparePr`/`mergeTaskPr` and
records `develop` as `done` with `resumed: true`; it first re-evaluates the independent review file
with the same domain check `mergeTaskPr` uses (pass, independent reviewer, every AC `met`). The
release PR is found before `prepareRelease` runs (open PR, or the merged release PR naming
`release`). If the release PR is already merged into `main` on a
head the PO approved natively, it skips the release wait and merge and continues to publish and deploy
(both idempotent). Every other gate (business, independent review, deploy approval, `sandbox`
environment) is still checked. Any mismatch (closed unmerged, different head, merge commit not on the
branch, no PO approval on the merged head) stops with an error; do not guess, have the Coordinator
inspect GitHub. Do not start another acceptance just to bypass an unknown dispatch.

Open product decisions: `omi init` exists (`src/interfaces/cli/commands/installation-commands.ts`),
and approval requests and task import are covered by ADR-0037 and `live-prep`; there is no
`login/run/retry` command. Creating the sandbox task branch is manual. There is no release merge use case (the
harness performs the pinned native API merge after the gate). Whether a future deploy approval
workflow can combine the durable digest decision with the native environment approval requires a
product decision. None of these gaps is implemented by this acceptance change.
A successful offline scenario is not evidence of the real PO approvals: the live run remains
unverified until the PO schedules and participates in it.
