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
