# OMI-047 beta acceptance record (2026-11-14 to 2026-11-15)

A factual record of the beta of the omi-squad framework on one new repository and one existing
repository. It comes from the CLI outputs kept under `/home/ttin/beta/evidence/` (file names are
cited below) and from the facts reported by the Coordinator. It holds no credential, token or
local secret. It does not accept the beta: `PO acceptance: pending`.

## Environment

| Item           | Value                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Framework      | package rebuilt from `develop` many times; final and pinned revision `a0a1af8`                 |
| Runtime        | WSL Ubuntu-24.04, Node 24.22.2                                                                 |
| Repositories   | `omi-hub-services/omi-beta-new` (new, empty), `omi-hub-services/omi-beta-brownfield` (existing) |
| GitHub Project | `omi-beta-new`: #3; `omi-beta-brownfield`: #4                                                  |
| Rulesets       | `beta-develop` (PR required), `beta-main` (PR and 1 approval); brownfield also requires check `test` |
| Accounts       | PO `ttin-omihub`; agent `minibox-claude-code`; worker profiles `claude-minibox`, `codex-ggtintran` |

## Session approach (PO-delegated)

The runtime ran with a placeholder `--coordinator` (a node process reading a never-closing stdin).
The Coordinator drove the CLI directly. The PO delegated this approach. It means the beta did not
exercise a real Claude Code Coordinator session; the placeholder process was killed and restarted
at each framework update.

## Timeline

### omi-beta-new (new repository, `init --variant new`)

- Install preview then apply, `doctor`, init preview then apply (`omi-beta-new-install-*.json`,
  `-doctor.json`, `-init-*.json`). The installer added marked spans only; user text was preserved.
- Task: Issue #3 `BN-001` (slugify), workflow `feature`. Business approval is a PO GitHub comment
  recorded with `approvals decide` (source `github-actor`; `omi-beta-new-approval-decide.txt`).
- Re-import changed the content hash. Before OMI-126 dispatch accepted the stale approval
  (security finding, P0, fixed); after it, dispatch and resume refused with
  `BUSINESS_APPROVAL_REQUIRED` / `BUSINESS_BASELINE_CHANGED`
  (`omi-beta-new-resume-stale-5622266.txt`, `omi-beta-new-resume.txt`).
- Run `04240a63-4f0e-4eb9-b27d-4c70667ccc62`: analyze → implement → verify → review all succeeded
  after the fixes. The run needed a PO reopen approval (`c7184ec6…`) and the PO authorized the
  Coordinator to act as Architect (see open findings).
- Delivery: refresh → verify → review → prepare-pr → review-comment → deliver. A stale review
  gate was refused (`omi-beta-new-deliver-2.txt`: `MERGE_REFUSED: STALE_REVISION,AC_LINE_MISSING`),
  the refresh path was added (OMI-141), then PR #21 merged as `1d656d1` (`omi-beta-new-deliver-final.txt`,
  2 AC ticked) and Issue #3 closed.
- Release `beta-1`: `prepare-release` → Issue #24, PR #25; PO native approval; `merge-release` →
  `main` `e22e78f` (`omi-beta-new-merge-release.json`); `publish-release` → tag and Release
  `beta-1` (`omi-beta-new-publish-release.json`).
- Release `beta-2`: Issue #28, PR #29 head `4bc66cf`; PO native approval; `merge-release` →
  `main` `799ef5c`; tag and Release `beta-2` (`omi-beta-new-*-beta2.json`).
- Deploy (OMI-121; PO decision: in v0.1 with a `project.yaml` allowlist). Environment `beta`
  (PO required reviewer, prevent_self_review, no admin bypass); workflow `deploy.yml` (PR #27);
  protected tag `deploy-r1` at `799ef5c` (tag ruleset `deploy-tags`); `project.yaml` deploy block
  and target `beta-r1` (digest `sha256:65645c7b…2a10`) via PR #31; report Issue #30.
  Deploy approval `42f86a20-d4ed-4d36-aad5-9d39aa7d2f3e` approved from PO comment `6880828707`
  (`omi-beta-new-deploy-approval-*.json/txt`). `deploy --target beta-r1` returned `pending`
  (`omi-beta-new-deploy-1.json`); the PO approved the native environment gate; the re-run returned
  `verified`: run `43616843619` success, deployment `7790551025` success, `nativeApproved: true`,
  digest equal to the approved digest (`omi-beta-new-deploy-2.json`).

### omi-beta-brownfield (existing repository, `init --variant existing`)

- Install and init as above (`omi-beta-brownfield-install-*.json`, `-init-*.json`, `-doctor-*`);
  user-owned `CLAUDE.md` / `AGENTS.md` text was preserved outside the marked spans.
- Task: Issue #3 `BB-001` (roundUpTotal), workflow `feature`. Dispatch before approval was
  refused with `BUSINESS_APPROVAL_REQUIRED` (`omi-beta-brownfield-dispatch-unapproved.txt`).
- Run `f3fd760c-64d9-4f2f-a69a-ed311fe951ba`: analyze → implement → verify → review all
  succeeded after the fixes; PO reopen approval `09bf61dd…`; Coordinator acted as Architect after
  `ARCHITECT_REQUIRED` (`omi-beta-brownfield-retry-analyze.txt`).
- Delivery: PR #20 merged as `4d97fce` (`omi-beta-brownfield-deliver-final.txt`, 2 AC ticked);
  Issue #3 closed. Brownfield had no release or deploy.

## Acceptance matrix AT-01..AT-14 (`docs/planning/project-plan.md` §10)

Results: `pass`, `fail`, `blocked`, `not exercised`. A row with sub-checks that were only partly
run is `not exercised` and lists the live part. No row is turned into `pass` by explanation.
Earlier live evidence is a separate note, not a beta pass.

| AT    | Result        | Evidence and notes                                                                                                                                  | Owner Issue |
| ----- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| AT-01 | pass          | Both repos installed and initialized; marked spans only, user text preserved: `*-install-apply.json`, `*-init-apply.json`, `*-doctor-init.json`     | OMI-033, OMI-045 |
| AT-02 | not exercised | `claude-minibox` ran the real analyze/implement/verify/review steps. The Codex profile was registered (`omi-beta-new-profile-codex.txt`) but the evidence read does not show a Codex step in the beta. Earlier live: Codex review in the OMI-042 record | OMI-013, OMI-014 |
| AT-03 | not exercised | No profile limit, failover or continuation was triggered. Only a probe-TTL finding (open findings)                                                   | OMI-018     |
| AT-04 | pass          | Every framework `update` required stopping the session (`PROJECT_OWNER_HELD` otherwise), so both runs survived about 15 session stop/start cycles and continued from durable state. omi-beta-new run `04240a63` was paused mid-implement (checkpoint `1317ef90`, `omi-beta-new-pause-stale.txt`) and resumed in a new session as rebaselined attempt `b2d95f53` (`omi-beta-new-resume-rebaseline.txt`). Caveat: the Coordinator was the placeholder process, killed each time; a real Claude Code Coordinator was not exercised | OMI-016, OMI-027, OMI-030 |
| AT-05 | not exercised | One task per repository; no two parallel tasks and no blocked dependency                                                                            | OMI-025     |
| AT-06 | pass          | Brownfield run `f3fd760c`: two failed analyze cycles (`bc126198`, `1890c449`) → `ARCHITECT_REQUIRED` (`omi-beta-brownfield-retry-analyze.txt`) → Architect solution recorded (`omi-beta-brownfield-architect.txt`, intervention `github-comment-6875893250`) → two assisted cycles failed (`52c928fa`, `82361a21`) → run `blocked` (`omi-beta-brownfield-wait-implement.txt`) → resumed only after PO reopen approval `09bf61dd…` (`-reopen-request.json`, `-reopen-decide.txt`). A second Architect decision for verify: `omi-beta-brownfield-architect-verify.txt` (intervention `github-comment-6878009224`). Caveat: the Coordinator performed the Architect role under PO authorization; no product Architect dispatch ran (open findings) | OMI-028     |
| AT-07 | not exercised | Live: stale review refused (`omi-beta-new-deliver-2.txt`, `STALE_REVISION`). Not run live: wrong-actor approval, missing Issue link                 | OMI-023, OMI-029 |
| AT-08 | not exercised | No GitHub timeout-after-success case was exercised                                                                                                  | OMI-024     |
| AT-09 | pass          | Delivery merged into `develop` and confirmed before `done`: new PR #21 `1d656d1`, brownfield PR #20 `4d97fce`; Issues closed, AC ticked              | OMI-023     |
| AT-10 | not exercised | Live: `main` release needed PO native approval (beta-1 PR #25, beta-2 PR #29 head `4bc66cf`). Not run: a new head invalidating an earlier approval | OMI-038     |
| AT-11 | pass          | Release approval alone did not deploy; deploy needed its own digest approval plus the native environment gate: `omi-beta-new-deploy-1.json` (`pending`), `-deploy-approval-*`, `-deploy-2.json` (`verified`) | OMI-040, OMI-041 |
| AT-12 | not exercised | No architecture violation or misplaced file was injected in a beta repo; the rule runs in the framework repository CI                                | OMI-043     |
| AT-13 | pass          | Evidence logs, final package, runtime artifacts/contexts and both state databases have no credential (secret hygiene below). The package, artifact and database scans were run by the Coordinator and are reported here, not re-run by the author | OMI-044, OMI-045 |
| AT-14 | not exercised | The chain Issue → develop → release → deploy ran live; the idea step did not, and docs-versus-behaviour (OMI-046) was not checked here. Earlier live: OMI-042 record | OMI-042, OMI-046, OMI-047 |

PO acceptance: pending. The PO decides whether the `not exercised` rows are accepted for v0.1,
deferred, or turned into follow-up Issues.

## Blockers found and fixed during the beta

| Issue | Fix | PR |
| ----- | --- | -- |
| OMI-118 #245 | doctor detects WSLInterop / System32 `wsl.exe` | #247 |
| OMI-119 #246 | shim pins `execPath` | #248 |
| OMI-120 #249 | session launcher node | #251 |
| OMI-121 #250 | deploy command and `project.yaml` allowlist | #296 |
| OMI-122 #252 | runtime PATH for worker CLIs | #253 |
| OMI-123 #254 | promote/set-status use projectDir | #255 |
| OMI-124 #256 | implementation map / Plan Key regex | #257 |
| OMI-125 #258 | `workspace.taskId` format | #259 |
| OMI-126 #260 | P0: stale business approval accepted | #261 |
| OMI-127 #262 | retry typed refusal | #282 |
| OMI-128 #263 | `BUSINESS_BASELINE_CHANGED` rebaseline | #265 |
| OMI-129 #264 | `RESULT_MISSING`: fenced final message | #266 |
| OMI-130 #267 | analyze artifact sha; redactor masked git SHAs | #268 |
| OMI-131 #269 | `artifact_root` | #270 |
| OMI-132 #271 | runtime runs checks | #272 |
| OMI-133 #273 | template archive | #274 |
| OMI-134 #275 | `TEMPLATE_UNAVAILABLE` retry tests and template hash | #295 |
| OMI-135 #276 | skill evidence prompt | #277 |
| OMI-136 #278 | optional revision fields | #279 |
| OMI-137 #280 | previous verdict / delta | #281 |
| OMI-138 #283 | check `evidenceRef` | #284 |
| OMI-139 #285 | `preparePr` wiring | #286 |
| OMI-140 #287 | workspace slug versus task id | #288 |
| OMI-141 #289 | refresh path for stale review | #291 |
| OMI-142 #290 | review AC-line validation | #292 |
| OMI-143 #293 | prepare/publish release wiring | #294 |

Every row is a filed Issue with a merged fix and a clear decision (fixed).

## Open findings not filed as Issues

Each needs a PO decision whether to file it.

| Finding | Suggested follow-up |
| ------- | ------------------- |
| `NOT_PLANNABLE` when the 5-minute probe TTL expired | name `PROFILE_STALE` in the refusal |
| `approvals list` prints JSON without `--json` | respect the output flag |
| Resume dirty-state check conflicts with the OMI-131 stray-file recovery (`GIT_MISMATCH`) | reconcile the two checks |
| No product Architect dispatch; the Coordinator acted as Architect under PO authorization 3× (intervention ids are GitHub comment ids, e.g. `github-comment-6875893250` for analyze and `github-comment-6878009224` for verify) | implement the Architect dispatch (AT-06 caveat) |
| No profile disable/remove command | add the command |
| No CLI for Project field mapping or rulesets (Coordinator used `gh`) | add commands or document the manual steps |
| `DIRTY_WORKTREE` surfaces as `PREVIOUS_VERDICT_OR_DELTA_MISSING` | surface the real cause |
| prepare-pr evidence is pinned at the first call (changed text → `PR_VERIFICATION_FAILED`) | allow a refresh or document it |
| Release Issues #24 and #28 stay open after `publish-release` | close them on publish |
| Every framework update moves beta `develop`, making reviews stale | document the refresh step |
| `sandbox-setup` is hardcoded to `omi-sandbox` (tooling only) | take the repository as an argument |
| `update` refuses `PROJECT_OWNER_HELD` while a session runs | expected; document: stop the session first |
| Coordinator tooling: `worker-report` refuses summaries over 4000 characters; transient `RUNTIME_UNAVAILABLE` flakes in integration tests under load | document the limit; investigate the flake |

## Secret hygiene

Run output went through the framework redactor. OMI-130 (#267) fixed the redactor masking git
SHAs, so SHAs in the cited files are readable. No token, auth header or email is copied into this
record; it cites file names instead.

Author scan of the 238 files under `/home/ttin/beta/evidence/` (Grep, 2026-11-14):

- `gh[opsu]_`, `github_pat_`, `Bearer `, `@gmail.com`: no match.
- `sk-`: 25 files matched. Every match is the tail of `task-` in task identifiers (checked on a
  sample: the matched text is `ask-`); the word-bounded pattern `\bsk-[A-Za-z0-9]` has no match.
  No key was found.

Coordinator scan (2026-11-14, reported by the Coordinator; the author did not re-run it) with
`gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9._-]{20,}|@gmail\.com|BEGIN [A-Z ]*PRIVATE KEY`:

- Final package `omi-squad-0.1.0.tgz` built from `a0a1af8`: 1160 files, no credential. The only
  `github_pat_` hits are the detector patterns in `dist/application/contracts/credential-input.js`,
  `dist/interfaces/ipc/ipc-server.js` and `dist/interfaces/cli/presenters/startup-error-presenter.js`.
- Runtime artifacts and contexts under `.omi-squad/local` of both beta repos (install backups
  excluded): 92 and 85 files, no match.
- Both `state.sqlite` databases (binary grep): no match.

These are pattern scans, not proof that no secret exists. Install backups were not scanned.
The beta ran 2026-11-14 to 2026-11-15 (local); all scans ran on 2026-11-14.

## What this shows against the Issue

- AC-1: one new repository and one existing repository ran a real task to a merged PR.
- AC-2: the cited logs are credential-free by the scan above.
- AC-3: the v0.1 matrix is filled in: 6 `pass` (AT-01, 04, 06, 09, 11, 13; AT-04 and AT-06 with the caveats in their rows), 0 `fail`, 0 `blocked`, 8 `not exercised`. The PO
  decides acceptance.
- AC-4: every blocker found has an Issue and a fix; open findings carry a suggested follow-up.
