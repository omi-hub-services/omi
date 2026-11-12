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
`stateDirectory` and optional `runbooks` (records above). Prepare a dedicated migrated state.db
and artifacts directory with approvals authenticated through the existing lifecycle. The test
does not import decisions from JSON. It dispatches only to a sandbox-named repository and
writes evidence under `.tmp/live/omi-041-deploy-evidence.json`. It waits up to ten minutes for
the PO's native approval. If dispatch is still unconfirmed, retain state and rerun to reconcile.
Default checks do not run it. The PO chooses sandbox repository, workflow/tag/SHA, protected
environment, image/digest, PO/report Issue and the time to run the probe.

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

Prepare this JSON locally (never credentials):

```json
{
  "repository": "omi-hub-services/omi-sandbox",
  "acceptanceId": "acceptance-042-a",
  "stateDirectory": "/absolute/dedicated/sandbox-state",
  "projectId": "sandbox-project",
  "taskId": "omi-042-acceptance-a",
  "idea": "Add the sandbox acceptance marker",
  "issueBody": "## Acceptance criteria\n- [ ] Marker meets the approved baseline.\n- [ ] Independent review and checks pass.",
  "baselineHash": "<64 lowercase hex SHA-256 of the reviewed requirements>",
  "businessApprovalId": "<authenticated business approval ID>",
  "head": "task/omi-042-acceptance-a",
  "evidence": ["<first criterion artifact reference>", "<second criterion artifact reference>"],
  "reviewFile": "/absolute/independent-review-evidence.json",
  "requiredChecks": ["ci"],
  "release": "acceptance-042-a",
  "artifactDigest": "sha256:<64 lowercase hex>",
  "deployApprovalId": "<authenticated deploy approval ID>",
  "pipeline": {
    "workflow": "sandbox-deploy.yml",
    "ref": "reviewed-pipeline-tag",
    "workflowSha": "<40 lowercase hex reviewed workflow commit>",
    "issueNumber": 123,
    "allowedActors": ["ttin-omihub"],
    "authorActor": "minibox-claude-code"
  },
  "timeoutSeconds": 600
}
```

`acceptanceId` identifies the durable Issue creation intent and evidence file; use a unique value
for a fresh acceptance, and never change the meaning of an existing intent. `projectId` must
exist in the dedicated migrated `state.db`, alongside `artifacts/`. The pipeline/report Issue
must already exist in the sandbox. `head` must be a pushed task branch based on develop with
the intended change and green named checks. `evidence` has one reference per top-level AC.
`reviewFile` must be an actual independent worker result exported as the validated
`mergeEvidenceSchema` shape: `review` (`reviewerRunId`, `reviewerAgentId`, `headSha`, `baseSha`,
`verdict`, `body` with one `AC-n: met` line per criterion), `authorRunIds`, `authorAgentIds`,
`unresolvedMandatoryFindings`, `workflowGatesPassed`. Do not invent review evidence or decisions.
The harness uses the application task-completion port in memory; it is a use-case acceptance
harness, not proof of a complete CLI installation or GitHub Project synchronization.

Before starting, the PO/Coordinator prepares the sandbox branches and rulesets from ADR-0015:
no bypass, native review required on main, named checks, and a protected `sandbox` environment
with required User reviewer `ttin-omihub`, prevent self-review, no admin bypass. Prepare the
reviewed workflow/tag/image as described above. The operator must verify that the immutable
image digest represents the intended task/release; there is no build-artifact provenance port
linking a Git commit to a container digest yet. Existing unrelated develop changes can enter
the release task list: inspect and isolate the sandbox before acceptance.

The PO must also supply **real, already authenticated** business and deploy decisions in the
dedicated ApprovalStore through `requestApproval`/`recordApproval` with the trusted CLI or
GitHub-comment decision source. Business subject is `{kind:"business", baselineHash,
scopeIds:[taskId]}`; deploy subject is `{kind:"deploy", artifactDigest, environment:"sandbox"}`.
A JSON config field or database edit is not authentication. These durable decisions are
additional to the two native GitHub gates; the harness never creates approvals itself.

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
This is not a general resume command: after task merge, `preparePr` may refuse a rerun because
the PR is closed. Have the Coordinator inspect completed stages and reconcile through existing
use cases; do not start another acceptance just to bypass an unknown dispatch.

Open product decisions: `approvals decide` remains NOT_IMPLEMENTED in runtime composition;
there is no CLI generator for `project.yaml` and no `init/login/run/retry` command. Branch/work
preparation and authenticated approval-store setup therefore require the existing application
boundaries and an operator, not undocumented CLI commands. There is no release merge use case
(the harness performs the pinned native API merge after the gate). Whether a future deploy
approval workflow can combine the durable digest decision with the native environment approval
requires a product decision. None of these gaps is implemented by this acceptance change.
A successful offline scenario is not evidence of the real PO approvals: the live run remains
unverified until the PO schedules and participates in it.
