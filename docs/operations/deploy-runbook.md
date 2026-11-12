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

Outbox keys hash the ordered tuple `[repository, environment, artifactDigest]`. Keep a single
runtime writer and the same state/artifact directory on restart. A timeout or lost response
never causes redispatch: the adapter reconciles run listings; absence remains unknown even
after the usual grace period. Retain runs and deployments until reconciliation completes.
An unresolved dispatch needs PO investigation, not an automatic retry or a changed key.
Changing pipeline configuration for an existing intent is a key conflict. A polling budget or
unavailable read returns pending; it neither cancels the run nor starts rollback. Failed,
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
A rollback intent pins its runbook reference and revision in the durable payload. If a previous
forward deploy already used that tuple, rollback refuses with `OPERATION_KEY_CONFLICT` rather
than treating the old success as a new restoration. A fresh redeploy campaign needs a PO/architecture
decision about operation identity rather than bypassing the required tuple idempotency.

The opt-in live test reads `OMI_LIVE_DEPLOY_CONFIG`, a JSON file containing `request`, `pipeline`,
`stateDirectory` and optional `runbooks` (records above). Prepare a dedicated migrated state.db
and artifacts directory with approvals authenticated through the existing lifecycle. The test
does not import decisions from JSON. It dispatches only to a sandbox-named repository and
writes evidence under `.tmp/live/omi-041-deploy-evidence.json`. It waits up to ten minutes for
the PO's native approval. If dispatch is still unconfirmed, retain state and rerun to reconcile.
Default checks do not run it. The PO chooses sandbox repository, workflow/tag/SHA, protected
environment, image/digest, PO/report Issue and the time to run the probe.
