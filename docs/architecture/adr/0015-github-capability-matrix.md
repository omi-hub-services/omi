# ADR-0015 — PoC: GitHub capability matrix (sandbox repo + Project, Free plan)

- Status: Accepted — all three OMI-006 acceptance criteria evidenced by a live run on 2026-11-10
  (run `20261110-134042`)
- Date: 2026-11-10
- Issue: #7 (OMI-006), epic #1, milestone M0 — Feasibility
- Context documents: `docs/architecture/architecture.md` §11, §16; `docs/planning/github-project.md`;
  `docs/product/product-overview.md` §9; ADR-0012 (Coordinator on Windows), ADR-0013 (live PoC
  pattern)
- Out of scope: the production adapters — init/Project mapping (OMI-019), PR creation and Issue
  linkage (OMI-022), outbox and reconciliation (OMI-024) — and the merge/approval/deploy use
  cases that consume this matrix (OMI-023, OMI-029, OMI-040)

## Context

omi-squad keeps task content and status on GitHub (Issues, sub-issues, native dependencies,
Project v2 fields) and relies on GitHub for the gates it must not fake: native PR approval by a
human, required status checks and production deployment approval (architecture.md §11, §12).
architecture.md §11 says the adapter must not assume that every GitHub plan offers every
enforcement mechanism. Before OMI-019/022/024 are built we need evidence of what actually works
for this organisation: **GitHub Free plan, a public repository, an org Project v2, and two real
GitHub accounts**.

The PO created an empty sandbox for this: repository `omi-hub-services/omi-sandbox` (public,
default branch `main`, only a README) and org Project #2 "omi-sandbox"
(`PVT_kwDOFSS4LM4Bq-O_`). The sandbox is public so that rulesets, required reviewers and
environment protection rules are available on the Free plan. The production repository
`omi-hub-services/omi` and Project #1 were never touched.

| Actor                 | Role in the probe                       | Where `gh` runs                         |
| --------------------- | --------------------------------------- | --------------------------------------- |
| `minibox-claude-code` | **author** (A): creates everything, opens PRs, dispatches the reviewer-gate run, merges | Coordinator, Windows (ADR-0012) |
| `ttin-omihub`         | **approver** (B): approves PRs and the deployment, triggers the self-review run | PO, WSL2 |

## Decision

### 1. How omi-squad uses GitHub (from the matrix below)

Everything the design relies on works on the Free plan with a public repository, **except one
thing**: a closing keyword in a PR into a non-default branch (`develop`) neither creates a
closing reference nor closes the Issue. omi-squad therefore:

- **OMI-022 — PR linkage.** Every task PR body carries `Issue: #N` (already required by CI's
  `issue-link` job). That is the canonical link. It is read back as a `cross-referenced` event
  on the Issue timeline (`GET /repos/{r}/issues/{n}/timeline`) and creates no closing reference.
  OMI-022 must not report a native "Development" link for PRs into `develop`, and must not rely
  on `Closes #N` there. `Closes #N` is only meaningful for release PRs into `main`, where it was
  proven to link and close.
- **OMI-024 — Issue close and Project sync.** After OMI-023 has confirmed the merge into
  `develop` on GitHub, OMI-024 closes the Issue itself through the outbox
  (`gh issue close --reason completed`, or REST `PATCH` `state=closed,state_reason=completed`),
  then reads `state`/`stateReason` back. Status and other fields are written with
  `updateProjectV2ItemFieldValue` (or `gh project item-edit`) and read back through
  `ProjectV2Item.fieldValues`. Sub-issues and dependencies use the REST endpoints below; the
  GraphQL fields `subIssues`, `parent`, `blockedBy` and `blocking` are the reconciliation read
  path.
- **OMI-019 — init and `doctor`.** Map Project fields by ID from
  `organization.projectV2.fields`; create missing fields with `gh project field-create` (all
  four types worked). `doctor` checks the token scopes `repo`, `workflow`, `project` and
  `read:org`, `viewerPermission`, the effective rules on the target branches
  (`GET /repos/{r}/rules/branches/{branch}`), that rulesets have **no bypass actors**, and the
  environment protection (`prevent_self_review`, `can_admins_bypass=false`).
- **OMI-023 — merge gate.** Read `mergeable`, `mergeStateStatus` and `reviewDecision` for the
  pinned head; read checks with the check-runs API **by head SHA, filtered by check name**; merge
  through the API and treat HTTP 405 "Repository rule violations found" as a gate refusal, using
  its message to report which rule (approval and/or named check) blocked.
- **OMI-029 / OMI-038 — approval.** Native approval is a hard server-side gate, and an author
  cannot approve their own PR, so the agent account (`minibox-claude-code`) authors PRs and the
  PO approves. This is the existing rule in `github-project.md`.
- **OMI-040 — deployment approval.** Use an environment with the PO as required reviewer,
  `prevent_self_review=true` and `can_admins_bypass=false`. The **agent account dispatches** the
  deploy and the **PO approves**. A PO-triggered run can never be approved by the PO.

### 2. The probe

The PoC is an opt-in live probe, not production code (same pattern as ADR-0013):

- `tests/live/github/main.ts` — entry point; phases `setup | approve | verify | cleanup` and the
  offline `matrix` printer. Run with `node` (ADR-0011 type stripping); there is no `*.test.ts`
  file, so neither `npm run check`, `npm run test:live` nor CI runs it.
- `tests/live/github/probe-model.ts` — pure part: argument parsing, the production guard,
  outcome classification, redaction and the matrix rows. Unit-tested in
  `tests/unit/live/github/probe-model.test.ts`. Capability ids are a TypeScript union, so a step
  naming an unknown matrix row fails `typecheck`.
- `tests/live/github/probe-session.ts` — runs `gh` with `child_process.execFile` (no shell,
  temp-directory cwd so no local checkout is picked up), records every call and persists the
  state file.
- `tests/live/github/project-issue-probes.ts`, `delivery-probes.ts`, `deployment-probes.ts`,
  `cleanup-probes.ts` — the probes per area.
- No new dependency; no change to `src/`. The adapters in `src/infrastructure/github/` must not
  import this code; they reuse the findings.

#### Guard

The probe refuses to start when `--repo` is `omi-hub-services/omi` (any case) or `--project` is
`1`. Later phases take repo and Project only from the state file and re-apply the same check.
Every single `gh` call is checked again: no argument or request body may name the production
repository, and a `gh project <sub> <number>` call must use the sandbox number. A refusal aborts
the phase before any request is sent.

#### Phases and state

The approval tests need two identities, so the probe is split into phases that share a JSON state
file (IDs only: issue numbers and ids, PR numbers, branch names, field/item ids, ruleset,
environment and run ids; never tokens):

1. **`setup`** (author) — Project v2 and Issue probes; commits the workflow to `main`; creates the
   environment, then the ruleset; creates branches, commits and three PRs through the API; reads
   the PR→Issue links back; waits for the checks; tries to merge before approval, to self-approve
   and to bypass the ruleset as admin; dispatches the reviewer-gate run and tries to approve it as
   a non-reviewer.
2. **`approve`** (approver; refuses to run as the author or as anyone but the environment
   reviewer) — approves both PRs into `main`; approves the waiting deployment; dispatches a second
   run itself and tries to approve it (`prevent_self_review`).
3. **`verify`** (author) — merges the approved PR and checks the closing keyword closed its Issue;
   shows the failing required check still blocks the approved check PR, pushes a fix commit, waits
   for green and merges; merges the PR into the non-default base and checks the Issue stays open;
   reads the deployment run, its approvals, deployments and statuses; confirms the self-review run
   is still waiting.
4. **`cleanup`** (any admin) — cancels unfinished runs, closes open PRs, deletes the ruleset, the
   environment, the workflow and probe files on `main`, the probe branches and the Project items;
   closes (or with `--delete-issues` deletes) the Issues; keeps the probe fields for the next run
   unless `--delete-fields`. A 404 counts as already gone, so cleanup can be re-run.

#### Sandbox objects

| Object | Purpose |
| ------ | ------- |
| Issues *parent* (#1), *child A* (#2), *child B* (#3), *dev* (#4) | parent = Project item and closed by PR; A/B = sub-issues (B removed again), A blocked by B (removed and re-added), B closed with reason; dev = linked by the PR into the non-default base |
| Project fields `Probe Select`, `Probe Text`, `Probe Number`, `Probe Date` (+ built-in `Status`) | created if missing; written with `gh project item-edit` (Status with the GraphQL mutation) and read back via GraphQL |
| `.github/workflows/omi-probe.yml` on `main` | job `probe-check` on PRs into `main`: fails when a file under `probe-check/` says `fail` (each PR adds its own file, so PRs never conflict); job `gated-deploy` on `workflow_dispatch`, `environment: omi-probe-gate` |
| Ruleset `omi-probe-<run>` on `~DEFAULT_BRANCH` | PR with 1 approval (`dismiss_stale_reviews_on_push=false`), required check `probe-check` (not strict), **no bypass actors** |
| Environment `omi-probe-gate` | required reviewer `ttin-omihub`, `prevent_self_review=true`, `can_admins_bypass=false`, no branch policy |
| PR *approve* (#5) → `main` | file says `pass`; body `Closes #1` + `Issue: #1`; tests the approval gate |
| PR *check* (#6) → `main` | file says `fail`; body `Issue: #1` only; tests the required-check gate and admin bypass |
| Branch `omi-probe/<run>/develop`, PR *dev* (#7) → it | stands in for `develop` (non-default base, no rules); body `Closes #4` + `Issue: #4` |

#### Result classification

Each step records `supported | unsupported | partial | error`, the short API form, the exact
command line with its stdin body, HTTP status (parsed from `gh: … (HTTP nnn)`), exit code, the
actor, a redacted error text and a few allowlisted observed values.

| Expectation | supported | unsupported | error |
| ----------- | --------- | ----------- | ----- |
| `success` (the call should work) | exit 0, no GraphQL `errors`, verification passed (`partial` if the readback differs) | HTTP 404/410, unknown GraphQL field, "not available"/plan message | other failures |
| `denied` (a gate should refuse) | non-zero exit with HTTP 4xx or a refusal message — **the gate held**; or HTTP 200 that acted on nothing (empty list) | the call was accepted — **the gate did not hold** | malformed call (unknown flag/field), timeout, gh missing |
| `observe` (a fact) | decided by the step from what it read | | |

Transient failures (5xx, network, timeout) are always `error`, never a finding. A matrix row is
`supported`/`unsupported`/`error` when all its steps agree, otherwise `partial`.

#### Evidence handling

Evidence is written after every step to the file given by `--evidence`. All phases append to the
same file. It holds the phases (actor, start/end, gh/node/platform versions) and the steps. `gh
auth status` output is reduced to the scope list. Tokens (`gh*_`, `github_pat_`, bearer headers)
and e-mail addresses are redacted. Commit SHAs and node IDs are kept as evidence. `node
tests/live/github/main.ts matrix --evidence <file>` prints the matrix from the evidence file
without calling GitHub. The file is gitignored and never committed.

#### Run commands

Prerequisites: author `gh` token with scopes `repo`, `workflow`, `project` and `read:org`;
approver token with `repo`. Node ≥ 24 on both sides. The Windows side runs the code from the WSL
share, so both actors use the same state and evidence files (PO-approved handover).

```powershell
# minibox-claude-code — Windows PowerShell (setup, then later verify and cleanup without --repo/--project/--approver)
node \\wsl.localhost\Ubuntu-24.04\home\ttin\github\omi\tests\live\github\main.ts setup --repo omi-hub-services/omi-sandbox --project 2 --approver ttin-omihub --state \\wsl.localhost\Ubuntu-24.04\home\ttin\github\omi\.tmp\live\omi-006-github-state.json --evidence \\wsl.localhost\Ubuntu-24.04\home\ttin\github\omi\.tmp\live\omi-006-github-evidence.json
```

```bash
# ttin-omihub — WSL bash, in /home/ttin/github/omi
node tests/live/github/main.ts approve --state .tmp/live/omi-006-github-state.json --evidence .tmp/live/omi-006-github-evidence.json
```

## Evidence

Live run `20261110-134042`, made by the **Coordinator** on 2026-11-10 at commit `d60b124`
(branch `task/omi-006-github-capability`). The phases ran in order:

| Phase   | Actor                 | Environment                                  | Time (UTC)          | Steps |
| ------- | --------------------- | -------------------------------------------- | ------------------- | ----- |
| setup   | `minibox-claude-code` | Windows 10.0.26200, gh 2.100.0, Node v24.22.2 | 13:40:43–13:42:58 | 78 supported, 1 unsupported |
| approve | `ttin-omihub`         | WSL2 5.15.167.4, gh 2.103.3, Node v24.22.2    | 13:43:15–13:43:47 | 14 supported |
| verify  | `minibox-claude-code` | as setup                                      | 13:43:57–13:45:55 | 25 supported, 1 unsupported |
| cleanup | `minibox-claude-code` | as setup                                      | 13:46:10–13:46:44 | 15 supported |

Total: **132 supported, 2 unsupported, 0 partial, 0 error**. No phase aborted. Both unsupported
steps are the same finding (non-default base linkage). Source:
`.tmp/live/omi-006-github-evidence.json` and `.tmp/live/omi-006-github-state.json` in the WSL
checkout (gitignored, not committed). Both tokens reported scopes `gist, project, read:org,
repo, workflow`. The repository was `public` with default branch `main`, `GET /orgs/{org}`
returned plan `free`, and `minibox-claude-code` had `admin` permission.

Cleanup used the PO default: Issues closed, Project fields kept. PRs #5–#7 are merged. Issues
#1 and #3 were already closed by the probe; #2 and #4 were closed by cleanup. Ruleset
`26946210`, the environment, the workflow, the probe files and all four `omi-probe/…` branches
were deleted, the Project item was removed, and the waiting self-review run was cancelled.

## Capability matrix

Actor: **A** = `minibox-claude-code` (author), **B** = `ttin-omihub` (approver). `{r}` is the
sandbox repository. Step ids are those in the evidence file.

| Capability | API/command | Actor | Result | Evidence | Consequence for omi-squad |
| ---------- | ----------- | ----- | ------ | -------- | ------------------------- |
| Actor, token scopes, repo permission, org plan | `GET /user`; `gh auth status --active` (scopes only); `GET /repos/{r}`; `GET /orgs/{org}`; `GET /users/{login}` | A, B | supported | `env.actor.*` (11 steps): both tokens have `gist,project,read:org,repo,workflow`; repo public, A admin; plan `free` | OMI-019 `doctor` checks these scopes and the permission before init |
| Project v2: read Project and fields | GraphQL `organization.projectV2.fields`; `gh project field-list` | A | supported | `project.read.graphql`, `project.read.cli`: 13 fields, id `PVT_kwDOFSS4LM4Bq-O_` | OMI-019 maps fields by ID |
| Project v2: create a field | `gh project field-create` (SINGLE_SELECT, TEXT, NUMBER, DATE) | A | supported | `project.field.{select,text,number,date}.create`: 4 field ids returned | OMI-019 init creates missing fields. The UI is needed only for view layout (github-project.md) |
| Project v2: add an Issue as item | `gh project item-add` | A | supported | `project.item.add` (3.7 s) | OMI-024 adds items through the outbox; auto-add workflow is an optional extra |
| Project v2: write/read single-select (incl. Status) | `gh project item-edit --single-select-option-id`; GraphQL `updateProjectV2ItemFieldValue`; readback `node(ProjectV2Item).fieldValues` | A | supported | `project.value.single-select.write/readback`, `project.value.status.write-graphql/readback`: option ids read back exactly | OMI-024 Status sync, with readback after each write |
| Project v2: write/read text | `gh project item-edit --text`; readback GraphQL | A | supported | `project.value.text.write/readback`: `probe 20261110-134042` round-trip | OMI-024 Plan Key / Run ID / Blocked Reason |
| Project v2: write/read number | `gh project item-edit --number`; readback GraphQL | A | supported | `project.value.number.write/readback`: `42.5` round-trip | OMI-024 numeric fields (none required today) |
| Project v2: write/read date | `gh project item-edit --date`; readback GraphQL | A | supported | `project.value.date.write/readback`: `2026-11-10` round-trip | OMI-024 date fields (none required today) |
| Issue: create | `POST /repos/{r}/issues` | A | supported | `issue.create.{parent,childA,childB,dev}` → #1–#4 | OMI-020/OMI-024 create Issues through the outbox; the response gives `number`, numeric `id` (needed for sub-issues/dependencies) and `node_id` |
| Sub-issue: add | `POST /repos/{r}/issues/{n}/sub_issues` (`sub_issue_id` = numeric id) | A | supported | `issue.sub-issue.add.2`, `.3` | OMI-024 writes the hierarchy natively; no task-list fallback needed |
| Sub-issue: list (and parent) | `GET …/sub_issues`; `GET …/parent`; GraphQL `issue.subIssues/parent` | A | supported | `issue.sub-issue.list.rest`, `.parent.rest`, `.list.graphql` | OMI-020 import, OMI-024 reconciliation (REST or GraphQL) |
| Sub-issue: remove | `DELETE /repos/{r}/issues/{n}/sub_issue` | A | supported | `issue.sub-issue.remove`, `.list.after-remove`: #3 gone, #2 kept | OMI-024 reconciliation when scope changes |
| Native dependency (blocked-by): add | `POST …/dependencies/blocked_by` (`issue_id` = numeric id) | A | supported | `issue.dependency.add.rest`, `.re-add`; GraphQL fallback `addBlockedBy` not needed | OMI-024 writes native dependencies; no text fallback needed |
| Native dependency: list blocked-by/blocking | `GET …/dependencies/blocked_by`, `…/blocking`; GraphQL `issue.blockedBy/blocking` | A | supported | `issue.dependency.list.{blocked-by,blocking,graphql}` | OMI-020 import and scheduler readiness (OMI-025) |
| Native dependency: remove | `DELETE …/dependencies/blocked_by/{id}` | A | supported | `issue.dependency.remove.rest`, `.list.after-remove` | OMI-024 reconciliation |
| Issue: close with reason | `gh issue close --reason completed`; `gh issue view --json state,stateReason` | A | supported | `issue.close.cli`, `.readback`: `CLOSED`/`COMPLETED` | OMI-024 closes task Issues itself after a verified merge into `develop` (see the non-default base row) |
| Branch + commit through the API (no clone) | `POST /repos/{r}/git/refs`; `PUT /repos/{r}/contents/{path}` | A | supported | `pr.branch.*`, `pr.commit.*`, `checks.required-blocks.fix-commit` (8 steps) | Probe plumbing only; OMI-021/OMI-022 push with git |
| PR: create | `gh pr create --repo --head --base` | A | supported | `pr.create.{approve,check,dev}.cli` → #5, #6, #7; works outside a checkout, so the REST fallback was not needed | OMI-022 opens task PRs (argv only; body via `--body`/stdin) |
| PR→Issue link: closing keyword, PR into default branch | GraphQL `closingIssuesReferences`; after merge `issue.state`, `closedByPullRequestsReferences` | A | supported | `pr.link.approve.closing-references`: reference to #1; `pr.link.closing-keyword.closed-by`: #1 closed by the merge of #5 | OMI-022 release PRs into `main` may use `Closes #N` |
| PR→Issue link: closing keyword, PR into non-default branch | GraphQL `closingIssuesReferences`; `issue.state` after merge | A | **unsupported** | `pr.link.dev.closing-references`: no closing reference (`[]`); `pr.link.non-default-base.issue-after-merge`: #4 stays `OPEN` after #7 merged | **Fallback (adopted):** OMI-022 links with `Issue: #N` and reads it back through the timeline; OMI-024 closes the Issue itself after OMI-023 confirms the merge into `develop`. Never report a native link |
| PR→Issue link: explicit `Issue: #N` read back | `GET /repos/{r}/issues/{n}/timeline` (`cross-referenced`); `closingIssuesReferences` | A | supported | `pr.link.explicit-reference.timeline`: #1 cross-referenced by PR #6; `pr.link.check.closing-references`: no closing reference (as expected) | OMI-022 canonical link; OMI-024 reconciles PR↔Issue from the timeline + PR body |
| PR: merge permission and mergeability | GraphQL `viewerPermission`, `viewerCanMergeAsAdmin`, `mergeable`, `mergeStateStatus`, `reviewDecision` | A | supported | `pr.merge-permission.approve.{before,after}-approval`: `ADMIN`, `viewerCanMergeAsAdmin=false` (no bypass actors) | OMI-023 merge gate inputs; `viewerCanMergeAsAdmin=false` confirms there is no bypass |
| PR: merge when all gates pass | `gh pr merge --merge`; readback `pullRequest.merged` | A | supported | `approval.blocks-merge.merge-after(.readback)`, `checks.required-blocks.merge-green(.readback)`, `pr.merge.non-default-base(.readback)` | OMI-023 merges through the API and confirms `merged=true` |
| Ruleset: 1 approval + required check | `POST /repos/{r}/rulesets`; `GET /repos/{r}/rules/branches/{branch}` | A | supported | `approval.ruleset.create` (id 26946210), `.effective-rules`: `pull_request` + `required_status_checks` | Free plan + public repo enforces rulesets; OMI-019 `doctor` reads effective rules |
| Required approval blocks merge until approved | `PUT /repos/{r}/pulls/{n}/merge`, `gh pr merge` before and after approval | A | supported | `approval.blocks-merge.state-before`: `BLOCKED`/`REVIEW_REQUIRED` with green check; `.rest-before`: HTTP 405 "At least 1 approving review is required…"; `.cli-before`: "base branch policy prohibits the merge"; `.state-after`: `CLEAN`/`APPROVED`; `.merge-after` merged | OMI-023/OMI-029 treat native approval as a hard server-side gate |
| PR author cannot approve own PR | `gh pr review --approve` by the author | A | supported | `approval.self-approval.cli`: GraphQL "Can not approve your own pull request (addPullRequestReview)" | OMI-029: the agent identity can never supply PO approval; the agent authors and the PO approves |
| Second actor approves; reviewDecision read back | `gh pr review --approve`; `gh pr view --json reviewDecision,latestReviews` | B | supported | `approval.other-actor.{approve,check}(.readback)`: `APPROVED` by `ttin-omihub` on the recorded head SHAs | OMI-029 reads approver login + head SHA from GitHub |
| Repo admin cannot bypass the ruleset | `PUT …/pulls/{n}/merge` and `gh pr merge --admin` as admin | A | supported | `approval.admin-bypass.rest`: HTTP 405 naming both missing approval and failing `probe-check`; `.cli`: GraphQL `mergePullRequest` rule violations | OMI-019 `doctor` requires empty `bypass_actors`; then gates hold for admins too |
| Actions workflow reports a check run | `PUT …/contents/.github/workflows/…` (`workflow` scope); `GET …/commits/{sha}/check-runs?check_name=` | A | supported | `checks.workflow.commit`; `.approve.reported` success; `.check.reported` failure; `checks.required-blocks.green` success on the fix commit | OMI-023 / OMI-036 CI; writing workflow files needs the `workflow` scope |
| Required status check blocks merge until green | merge refused while red (already approved), fix commit, merge after green | A | supported | `checks.required-blocks.state-failing`: `BLOCKED` with `APPROVED`; `.rest-failing`: HTTP 405 "Required status check "probe-check" is failing"; `.state-green`: `CLEAN`, approval kept; `.merge-green` merged | OMI-023 relies on server-side check enforcement; it must still pin the head SHA itself (here the approval survived a new commit because `dismiss_stale_reviews_on_push=false`) |
| Read check runs: check-runs API vs `gh pr checks` | `GET …/commits/{sha}/check-runs`; `gh pr checks --json` (exit 1 = failing, 8 = pending); `gh pr view --json statusCheckRollup` | A | supported | `checks.read.{failing,green}.*`: all three agree (failure→`fail`/`FAILURE`, success→`pass`/`SUCCESS`); check-runs lists 2 runs (incl. the skipped `gated-deploy`) | OMI-023 reads check-runs **by head SHA and check name**; `gh pr checks` follows the current head and needs exit codes 1/8 treated as data |
| Environment with required reviewer + prevent_self_review | `PUT /repos/{r}/environments/{env}`; `GET` readback | A | supported | `deploy.environment.create`, `.readback`: `preventSelfReview=true`, `canAdminsBypass=false`, reviewer `ttin-omihub` | OMI-040 production approval gate is available on Free + public |
| Job targeting the environment waits | `gh workflow run --ref`; `GET /repos/{r}/actions/runs/{id}` | A, B | supported | `deploy.dispatch.*`, `deploy.job-waits.{reviewerGate,selfReview}`: both runs `waiting` | OMI-040/OMI-041 dispatch, then poll the run |
| Non-reviewer (admin) cannot approve the deployment | `GET …/pending_deployments` (`current_user_can_approve`); `POST …/pending_deployments` | A | supported | `deploy.non-reviewer-denied.pending`: `current_user_can_approve=false`; `.approve`: "No pending deployment requests to approve or reject (Validation Failed)"; `.status-after`: still `waiting`; `.pending-self-run`: false | OMI-040: only listed reviewers approve; admin rights do not help when `can_admins_bypass=false` |
| Listed reviewer approves; job runs | `POST …/pending_deployments` by B; `gh run view --json jobs` | B, A | supported | `deploy.reviewer-approves.pending`: `true`; `.approve`; `.status-after`: `queued`; `.run-view`: `gated-deploy` succeeded | OMI-040: the PO approves on GitHub; the runtime waits for the job result |
| prevent_self_review: triggering reviewer cannot approve | B dispatches, B `POST …/pending_deployments`; run stays `waiting` | B, A | supported | `deploy.self-review-denied.pending`: `current_user_can_approve=false`; `.approve`: same "No pending deployment requests…" refusal; `.still-waiting` in verify | OMI-040: the agent account dispatches the deploy and the PO approves it; a PO-triggered run blocks forever |
| Read deployment gate state and approvals | `GET …/runs/{id}/approvals`; `GET /repos/{r}/deployments?environment=`; `GET …/deployments/{id}/statuses` | A | supported | `deploy.state-read.approvals`: approved by `ttin-omihub`; `.deployments`: 2 deployments; `.deployment-statuses`: read the newest (self-review, `waiting`), see Changes after the run | OMI-040/OMI-024 reconcile deploy state: approvals give actor and comment; deployment `creator` = triggering actor |
| Cleanup leaves the sandbox reusable | `gh run cancel`, `DELETE` ruleset/environment/contents/refs, `gh project item-delete`, `gh issue close --reason "not planned"` | A | supported | `cleanup.*` (13 steps), no failures | Probe re-runnable; fields kept for the next run |

## Findings

1. **Only one gap: closing keywords for a non-default base.** A PR into
   `omi-probe/<run>/develop` with `Closes #4` had an empty `closingIssuesReferences`, and #4
   stayed `OPEN` after the merge. The same keyword into `main` linked and closed #1. This
   confirms product-overview.md §9.3 and fixes the fallback (Decision §1, OMI-022/OMI-024).
2. **`Issue: #N` is a reliable explicit link.** It produced a `cross-referenced` timeline event
   (found on the first poll) and, correctly, no closing reference. This is what CI's
   `issue-link` job already enforces.
3. **Rulesets enforce server-side on Free + public, including against admins.** The REST merge
   returned HTTP 405 "Repository rule violations found", with one line per failing rule
   (missing approval, failing named check). `gh pr merge` refused locally ("the base branch
   policy prohibits the merge"), and `--admin` failed in GraphQL `mergePullRequest`.
   `viewerCanMergeAsAdmin` is `false` when the ruleset has no bypass actors.
4. **Self-approval is refused by GitHub** (GraphQL `addPullRequestReview`: "Can not approve your
   own pull request"). Two agents on one GitHub identity can never count as two reviewers
   (architecture.md §11).
5. **Approval survives new commits unless the ruleset dismisses it.** With
   `dismiss_stale_reviews_on_push=false`, the approval on #6 still counted after the fix commit.
   The production `main` ruleset dismisses stale approvals, but `develop` has 0 required
   approvals. OMI-023/OMI-029 must keep pinning reviews and approvals to the head SHA
   themselves.
6. **Check reads agree, with two traps.** check-runs, `gh pr checks` and `statusCheckRollup`
   gave the same conclusion. But the check-runs list for a SHA also contains skipped jobs, so
   filter by name. `gh pr checks` exits 1 (failing) or 8 (pending) while still printing valid
   JSON.
7. **Deployment gate works as designed on Free + public.** The job waits. A non-reviewer
   admin sees `current_user_can_approve=false`, and so does the reviewer who triggered the run
   (`prevent_self_review`). The approving reviewer's run went `queued` and the job succeeded.
   `/approvals` names the approver. Deployment `creator` is the triggering actor.
8. **Deployment refusals are indistinguishable by message.** Both the non-reviewer and the
   self-review refusals were "No pending deployment requests to approve or reject (Validation
   Failed)". gh printed no `(HTTP nnn)` here, so the probe recorded no status. OMI-040 must read
   `current_user_can_approve` (and the run's triggering actor) before posting, to explain a
   refusal.
9. **Project v2 and Issue relations are fully scriptable.** All four field types were created
   and written, Status was set via both `gh project item-edit` and GraphQL, and values read back
   exactly. The sub-issue and dependency REST endpoints and the GraphQL `subIssues`, `parent`,
   `blockedBy` and `blocking` fields all exist on this plan. The REST endpoints take the
   **numeric** issue id, not the number or node id.
10. **Tooling:** `gh pr create --repo --head --base` works outside a git checkout. Node v24.22.2
    on Windows ran the `.ts` probe from `\\wsl.localhost\…` and wrote state/evidence there; gh
    2.100.0 (Windows) and 2.103.3 (WSL) behaved the same.

### Changes after the run

- `deploy.state-read.deployment-statuses` read only the newest deployment, which belonged to the
  self-review run (`waiting`). The approved run's success is evidenced by
  `deploy.reviewer-approves.run-view` and `deploy.state-read.approvals`, not by its deployment
  status. The probe now reads the statuses of **every** deployment of the environment (step id
  `deploy.state-read.deployment-statuses.<creator>`) and expects the approved run's deployment to
  end in `success`. **Not re-run.**
- The catalog consequence of the non-default-base row now states the adopted fallback.

## Acceptance criteria (Issue #7)

| AC | Status | Evidence |
| -- | ------ | -------- |
| 1. Sandbox repo/Project: read/write fields, Issue/sub-issue/dependency, PR link and merge permission | Met | Matrix rows *Project v2* (7), *Issue/Sub-issue/Native dependency* (8), *PR→Issue link* (3), *PR: merge permission*, *PR: merge*; run `20261110-134042` |
| 2. Verify actor approval, native checks, deployment gate | Met | Rows *Required approval blocks merge*, *PR author cannot approve*, *Second actor approves*, *Admin cannot bypass*; *Actions workflow*, *Required status check blocks merge*, *Read check runs*; the six *deploy* rows |
| 3. Clear capability matrix | Met | The capability matrix above (38 rows, results, evidence, consequences) and the adopted decisions in Decision §1 |

## Proven / not proven

| Claim | Status |
| ----- | ------ |
| Probe refuses the production repo / Project #1 | Proven locally (exit 2 before any gh call) and by unit tests |
| Every capability in the matrix on Free plan + public repo | Proven (one live run), except non-default-base closing keywords: proven **not** to work |
| Approved run's deployment status read via `/deployments/{id}/statuses` | **Not proven**: the run read the self-review deployment; fixed, not re-run |
| Same behaviour on a **private** repository or the private production Project | **Not proven**: rulesets/environments on private repos need a paid plan; the production repo is public |
| Rate limits, pagination beyond one page, retry-after | **Not proven**: small volumes only; OMI-024 must handle them |
| Stale-approval dismissal (`dismiss_stale_reviews_on_push=true`) and `require_last_push_approval` | **Not proven**: the sandbox ruleset disabled them on purpose |
| Repeatability | One run; cleanup succeeded, so the sandbox is ready for a re-run |

## Risks

- **Recent APIs.** The sub-issue and issue-dependency endpoints are recent. OMI-024 must keep
  secret-free response fixtures in `tests/contract/` and re-run this probe on gh/GitHub changes.
- **Plan dependency.** Rulesets, required reviewers and environment protection worked because
  the repositories are public. Making the production repository private on the Free plan would
  remove these gates. OMI-019 `doctor` must detect this and report the reduced enforcement,
  not assume it.
- **Message-based classification.** Refusal reasons come from human-readable text (HTTP 405
  rule lines, the deployment "Validation Failed" message) and may change. Adapters should
  prefer structured reads (`mergeStateStatus`, `reviewDecision`, `current_user_can_approve`)
  and use the message only for reporting.
- **Same logins as production.** Both accounts can write to the production repository. The
  probe's guard (target check plus per-call check) is the only protection against a wrong
  argument.
