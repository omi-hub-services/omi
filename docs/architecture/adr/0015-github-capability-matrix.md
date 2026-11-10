# ADR-0015 — PoC: GitHub capability matrix (sandbox repo + Project, Free plan)

- Status: Proposed — probe built, **live run pending** (every matrix row is `pending live run`)
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
`omi-hub-services/omi` and Project #1 are never touched.

| Actor                 | Role in the probe                       | Where `gh` runs                         |
| --------------------- | --------------------------------------- | --------------------------------------- |
| `minibox-claude-code` | **author**: creates everything, opens PRs, dispatches the reviewer-gate run, merges | Coordinator, Windows (ADR-0012) |
| `ttin-omihub`         | **approver**: approves PRs and the deployment, triggers the self-review run | PO, WSL2 |

## Decision

The PoC is an opt-in live probe, not production code (same pattern as ADR-0013):

- `tests/live/github/main.ts` — entry point; phases `setup | approve | verify | cleanup` and the
  offline `matrix` printer. Run with `node` (ADR-0011 type stripping); there is no `*.test.ts`
  file, so neither `npm run check`, `npm run test:live` nor CI runs it.
- `tests/live/github/probe-model.ts` — pure part: argument parsing, the production guard,
  outcome classification, redaction and the matrix rows. Unit-tested in
  `tests/unit/live/github/probe-model.test.ts`.
- `tests/live/github/probe-session.ts` — runs `gh` with `child_process.execFile` (no shell,
  temp-directory cwd so no local checkout is picked up), records every call, persists the state
  file.
- `tests/live/github/project-issue-probes.ts`, `delivery-probes.ts`, `deployment-probes.ts`,
  `cleanup-probes.ts` — the probes per area.
- No new dependency; no change to `src/`. The adapters in `src/infrastructure/github/` must not
  import this code; they reuse the findings.

### Guard

The probe refuses to start when `--repo` is `omi-hub-services/omi` (any case) or `--project` is
`1`. Later phases take repo and Project only from the state file and re-apply the same check.
Every single `gh` call is checked again: no argument or request body may name the production
repository, and a `gh project <sub> <number>` call must use the sandbox number. A refusal aborts
the phase before any request is sent.

### Phases and state

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

### Sandbox objects

| Object | Purpose |
| ------ | ------- |
| Issues *parent*, *child A*, *child B*, *dev* | parent = Project item and closed by PR; A/B = sub-issues (B removed again), A blocked by B (removed and re-added), B closed with reason; dev = linked by the PR into the non-default base |
| Project fields `Probe Select`, `Probe Text`, `Probe Number`, `Probe Date` (+ built-in `Status`) | created if missing; written with `gh project item-edit` (Status with the GraphQL mutation) and read back via GraphQL |
| `.github/workflows/omi-probe.yml` on `main` | job `probe-check` on PRs into `main`: fails when a file under `probe-check/` says `fail` (each PR adds its own file, so PRs never conflict); job `gated-deploy` on `workflow_dispatch`, `environment: omi-probe-gate` |
| Ruleset `omi-probe-<run>` on `~DEFAULT_BRANCH` | PR with 1 approval (`dismiss_stale_reviews_on_push=false`), required check `probe-check` (not strict), **no bypass actors** |
| Environment `omi-probe-gate` | required reviewer `ttin-omihub`, `prevent_self_review=true`, `can_admins_bypass=false`, no branch policy |
| PR *approve* → `main` | file says `pass`; body `Closes #parent` + `Issue: #parent`; tests the approval gate |
| PR *check* → `main` | file says `fail`; body `Issue: #parent` only; tests the required-check gate and admin bypass |
| Branch `omi-probe/<run>/develop`, PR *dev* → it | stands in for `develop` (non-default base, no rules); body `Closes #dev` + `Issue: #dev` |

### Result classification

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

### Evidence handling

Evidence is written after every step to the file given by `--evidence` (suggested
`.tmp/live/omi-006-github-evidence.json`, gitignored, never committed); all phases append to the
same file. It holds the phases (actor, start/end, gh/node/platform versions) and the steps. `gh
auth status` output is reduced to the scope list; tokens (`gh*_`, `github_pat_`, bearer headers)
and e-mail addresses are redacted. Commit SHAs and node IDs are kept as evidence. `node
tests/live/github/main.ts matrix --evidence <file>` prints the matrix table below from the
evidence file without calling GitHub.

## Run

Prerequisites: author `gh` token with scopes `repo`, `workflow`, `project`, `read:org`
(`gh auth refresh -s project,workflow`); approver token with `repo`. Node ≥ 24 on both sides.
The code exists only in the WSL checkout (no push), so the Windows side runs it from the WSL
share and both actors use the same state and evidence files.

```powershell
# 1. minibox-claude-code — Windows PowerShell
node \\wsl.localhost\Ubuntu-24.04\home\ttin\github\omi\tests\live\github\main.ts setup --repo omi-hub-services/omi-sandbox --project 2 --approver ttin-omihub --state \\wsl.localhost\Ubuntu-24.04\home\ttin\github\omi\.tmp\live\omi-006-github-state.json --evidence \\wsl.localhost\Ubuntu-24.04\home\ttin\github\omi\.tmp\live\omi-006-github-evidence.json
```

```bash
# 2. ttin-omihub — WSL bash, in /home/ttin/github/omi
node tests/live/github/main.ts approve --state .tmp/live/omi-006-github-state.json --evidence .tmp/live/omi-006-github-evidence.json
```

Then `verify` and `cleanup` as in step 1 (author, Windows), and `matrix --evidence …` anywhere.

## Capability matrix

Actor: **A** = `minibox-claude-code` (author), **B** = `ttin-omihub` (approver). `{r}` is the
sandbox repository.

| Capability | API/command | Actor | Result | Evidence | Consequence for omi-squad |
| ---------- | ----------- | ----- | ------ | -------- | ------------------------- |
| Actor, token scopes, repo permission, org plan | `GET /user`; `gh auth status --active`; `GET /repos/{r}`; `GET /orgs/{org}`; `GET /users/{login}` | A, B | pending live run | — | OMI-019 `doctor` verifies identity and scopes before init |
| Project v2: read Project and fields | GraphQL `organization.projectV2.fields`; `gh project field-list` | A | pending live run | — | OMI-019 maps fields by ID |
| Project v2: create a field | `gh project field-create` (single-select, text, number, date) | A | pending live run | — | OMI-019 init creates missing fields; fallback: PO creates them on the UI |
| Project v2: add an Issue as item | `gh project item-add` | A | pending live run | — | OMI-024 adds items; fallback: built-in auto-add workflow |
| Project v2: write/read single-select (incl. Status) | `gh project item-edit --single-select-option-id`; GraphQL `updateProjectV2ItemFieldValue`; readback `node(ProjectV2Item).fieldValues` | A | pending live run | — | OMI-024 Status sync |
| Project v2: write/read text | `gh project item-edit --text`; readback GraphQL | A | pending live run | — | OMI-024 Plan Key / Run ID / Blocked Reason |
| Project v2: write/read number | `gh project item-edit --number`; readback GraphQL | A | pending live run | — | OMI-024 numeric fields (none required today) |
| Project v2: write/read date | `gh project item-edit --date`; readback GraphQL | A | pending live run | — | OMI-024 date fields (none required today) |
| Issue: create | `POST /repos/{r}/issues` | A | pending live run | — | OMI-020/OMI-024 create Issues through the outbox |
| Sub-issue: add | `POST /repos/{r}/issues/{n}/sub_issues` | A | pending live run | — | OMI-024 writes hierarchy; fallback: task list in the parent body |
| Sub-issue: list (and parent) | `GET …/sub_issues`; `GET …/parent`; GraphQL `issue.subIssues/parent` | A | pending live run | — | OMI-020 import, OMI-024 reconciliation |
| Sub-issue: remove | `DELETE /repos/{r}/issues/{n}/sub_issue` | A | pending live run | — | OMI-024 reconciliation |
| Native dependency (blocked-by): add | `POST …/dependencies/blocked_by` (fallback GraphQL `addBlockedBy`) | A | pending live run | — | OMI-024 writes dependencies; fallback: `Blocked by #N` text + Blocked Reason |
| Native dependency: list blocked-by/blocking | `GET …/dependencies/blocked_by`, `…/blocking`; GraphQL `issue.blockedBy/blocking` | A | pending live run | — | OMI-020 import, scheduler readiness (OMI-025) |
| Native dependency: remove | `DELETE …/dependencies/blocked_by/{id}` | A | pending live run | — | OMI-024 reconciliation |
| Issue: close with reason | `gh issue close --reason completed`; `gh issue view --json state,stateReason` | A | pending live run | — | OMI-024 closes Issues after a verified merge |
| Branch + commit through the API (no clone) | `POST /repos/{r}/git/refs`; `PUT /repos/{r}/contents/{path}` | A | pending live run | — | Probe plumbing; OMI-021/OMI-022 push with git |
| PR: create | `gh pr create --repo --head --base` (fallback `POST /repos/{r}/pulls`) | A | pending live run | — | OMI-022 opens task PRs |
| PR→Issue link: closing keyword, PR into default branch | GraphQL `closingIssuesReferences`; after merge `issue.state`, `closedByPullRequestsReferences` | A | pending live run | — | OMI-022 release PRs into `main` |
| PR→Issue link: closing keyword, PR into non-default branch | GraphQL `closingIssuesReferences`; `issue.state` after merge | A | pending live run | — | OMI-022 task PRs into `develop`; fallback: explicit link + close by OMI-024 |
| PR→Issue link: explicit `Issue: #N` read back | `GET /repos/{r}/issues/{n}/timeline` (`cross-referenced`); `closingIssuesReferences` stays empty | A | pending live run | — | OMI-022 canonical link |
| PR: merge permission and mergeability | GraphQL `viewerPermission`, `viewerCanMergeAsAdmin`, `mergeable`, `mergeStateStatus`, `reviewDecision` | A | pending live run | — | OMI-023 merge gate inputs |
| PR: merge when all gates pass | `gh pr merge --merge`; readback `pullRequest.merged` | A | pending live run | — | OMI-023 merges through the API |
| Ruleset: 1 approval + required check | `POST /repos/{r}/rulesets`; `GET /repos/{r}/rules/branches/{branch}` | A | pending live run | — | OMI-019 doctor / OMI-023 rely on server-side enforcement |
| Required approval blocks merge until approved | `PUT /repos/{r}/pulls/{n}/merge` and `gh pr merge` before (denied) and after approval | A | pending live run | — | OMI-023/OMI-029 treat native approval as a hard gate |
| PR author cannot approve own PR | `gh pr review --approve` by the author (denied) | A | pending live run | — | OMI-029: the agent identity can never satisfy PO approval |
| Second actor approves; reviewDecision read back | `gh pr review --approve`; `gh pr view --json reviewDecision,latestReviews` | B | pending live run | — | OMI-029 reads approval actor and head from GitHub |
| Repo admin cannot bypass the ruleset | `PUT …/pulls/{n}/merge` and `gh pr merge --admin` as admin (denied) | A | pending live run | — | OMI-023: no bypass actor, gates hold for admins |
| Actions workflow reports a check run | `PUT …/contents/.github/workflows/…` (`workflow` scope); `GET …/commits/{sha}/check-runs` | A | pending live run | — | OMI-023 / OMI-036 CI workflows |
| Required status check blocks merge until green | merge denied while red (approved), fix commit, merge after green | A | pending live run | — | OMI-023 relies on server-side check enforcement |
| Read check runs: check-runs API vs `gh pr checks` | `GET …/commits/{sha}/check-runs`; `gh pr checks --json` (exit 1/8); `gh pr view --json statusCheckRollup` | A | pending live run | — | OMI-023 read path pinned to the head SHA |
| Environment with required reviewer + prevent_self_review | `PUT /repos/{r}/environments/{env}`; `GET` readback | A | pending live run | — | OMI-040 production approval gate |
| Job targeting the environment waits | `gh workflow run`; `GET /repos/{r}/actions/runs/{id}` status `waiting` | A, B | pending live run | — | OMI-040/OMI-041 dispatch then wait |
| Non-reviewer (admin) cannot approve the deployment | `GET …/pending_deployments` (`current_user_can_approve`); `POST …/pending_deployments` (denied) | A | pending live run | — | OMI-040: only listed reviewers approve |
| Listed reviewer approves; job runs | `POST …/pending_deployments` by B; `gh run view --json jobs` | B, A | pending live run | — | OMI-040: PO approves on GitHub |
| prevent_self_review: triggering reviewer cannot approve | B dispatches, B `POST …/pending_deployments` (denied); run stays `waiting` | B, A | pending live run | — | OMI-040: the PO must not trigger the deploy they approve |
| Read deployment gate state and approvals | `GET …/runs/{id}/approvals`; `GET /repos/{r}/deployments?environment=`; `GET …/deployments/{id}/statuses` | A | pending live run | — | OMI-040/OMI-024 reconcile deploy state |
| Cleanup leaves the sandbox reusable | `gh run cancel`, `gh pr close`, `DELETE` ruleset/environment/contents/refs, `gh project item-delete`, `gh issue close`/`delete` | A | pending live run | — | Probe re-runnable |

## Findings

Pending the live run. Filled in from the evidence file, with the run date, commit, gh version and
actors, as in ADR-0013.

## Acceptance criteria (Issue #7)

| AC | Status | Evidence |
| -- | ------ | -------- |
| 1. Sandbox repo/Project: read/write fields, Issue/sub-issue/dependency, PR link and merge permission | Pending live run | Project, Issue and PR rows |
| 2. Verify actor approval, native checks, deployment gate | Pending live run | `approval.*`, `checks.*`, `deploy.*` rows |
| 3. Clear capability matrix | Structure done; results pending | this ADR |

## Risks

- **Undocumented or new endpoints.** Sub-issue and issue-dependency REST/GraphQL APIs are recent;
  shapes may change. The probe records the exact call and error so a change shows up as
  `unsupported`/`error` with text, not as a silent pass.
- **Timing.** Mergeability, check runs, timeline cross-references and run status are computed
  asynchronously; the probe polls with bounded waits (`--wait-seconds`, default 600) and records a
  timeout as `error`, not as a finding.
- **Client-side vs server-side refusal.** `gh pr merge` may refuse locally from
  `mergeStateStatus`; the REST merge attempt is recorded separately as the server-side truth.
- **Admin bypass attempt can succeed.** If GitHub lets the admin merge the check PR, the row
  records `unsupported` and the later green-merge steps on that PR report errors; that is the
  finding.
- **Sandbox residue.** A crashed phase leaves objects behind; the state file is written after each
  creation so `cleanup` can still remove them.
- **Same `gh` login as production.** Both accounts can write to the production repository; the
  guard (target check plus per-call check) is the only protection against a wrong argument.
