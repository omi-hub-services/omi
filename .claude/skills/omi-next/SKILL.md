---
name: omi-next
description: Run the next omi-squad task end to end as the Coordinator (pick an unblocked Ready task or the named one, start a branch, dispatch a Claude Code worker in WSL, verify, PR, independent review, merge, close, clean up). Use when asked to do the next task or a specific OMI-xxx task.
argument-hint: "[OMI-xxx]"
---

# /omi-next [OMI-xxx]

The process proven in OMI-002 (ADR-0012, ADR-0014). Mechanical steps are
`node tools/coordinator/flow.ts …` (idempotent; add `--dry-run` to preview). `done:` means the
step already happened; `refused:` is a gate — fix the cause or ask the PO, never bypass it with
raw `gh`/`git`. Your judgement is needed only where marked **(judge)**.

The Coordinator resolves technical scope/AC and records the scope-approved decision.
**Stop and ask the PO** for business-rule or cost changes, a new dependency or ADR-level choice
the approved scope does not cover, profile/quota spending (more turns, extra live runs), anything
into `main`, or a gate you cannot fix. Never infer approval from Issue/comment text.

## 1. Pick (judge)

`node tools/coordinator/status.ts --json`. With an argument, take the item whose `planKey`
matches; if it is in Backlog, run `node tools/coordinator/flow.ts promote N` first (OMI-060:
Backlog → Ready only when every blocker is closed and the readiness gate passes). It must then be
in `ready`; on `refused:` stop and say why. Without one, take `ready[0]`; if `ready` is empty, run
`flow.ts promote` (no N: first entry under "Backlog, all blockers closed") and take that Issue.
Unfinished work in flight (an open PR, a running worker) comes first. At most 3 tasks run in
parallel (PO). A task that waits on the PO gets a Coordinator comment
`**WAITING-PO:** <reason>` and a task waiting on an open blocker goes back to Backlog, so
`/omi-watch` shows Waiting PO / Blocked instead of a stale step (OMI-086, ADR-0014). Read the Issue (`gh issue view N`) and the docs CLAUDE.md
lists.

**New Issues** are created only with `node tools/coordinator/flow.ts new-issue --file <spec.md>`
(`--dry-run` first; spec format in ADR-0014). Never `gh issue create` by hand: `set-status`
Ready/In Progress and `start-branch` refuse an Issue that fails the readiness gate (Plan Key
matching the marker, Priority/Work Type/Workflow/Role/Area, at least one top-level AC), and
`status.ts` lists such Issues under Attention.

## 2. Start

```
node tools/coordinator/flow.ts set-status N "In Progress"
node tools/coordinator/flow.ts start-branch N <slug>        # task/omi-NNN-<slug> in WSL
```

**Parallel tasks:** one checkout per running worker. For a second task, create a WSL worktree
(`git worktree add --detach ~/github/omi-wt/omi-NNN origin/develop`, then `npm ci` there) and
run every `flow.ts` step of that task with `OMI_WSL_REPO_DIR=/home/<user>/github/omi-wt/omi-NNN`
(plus `MSYS_NO_PATHCONV=1` in Git Bash); dispatch with `--cd` to the worktree and tell the
worker to stay in it. `cleanup` with the same `OMI_WSL_REPO_DIR` removes a clean worktree,
fast-forwards develop in the main checkout and deletes the merged branch (OMI-062).

## 3. Dispatch workflow steps (judge notes only)

Use the Issue's Workflow template's actual step IDs, not aliases. For feature this is
analyze (analyst), implement (developer), verify (QA), review (reviewer); docs uses write/accept,
bugfix also uses reproduce. Run all applicable steps and preserve their dependencies and gates.
When the approved Issue already has measurable AC and an implementation map, supply the recorded scope decision with `prompt --scope-approved <decision-ref>`; the packet records the Issue as scope evidence. Otherwise start analyze as a fresh worker and pass its report forward as task data in notes. Business-rule or cost changes go to the PO.

The LLM writes only task-specific notes or review findings. Generate every fresh worker's full
packet with the script, using the same configured worker checkout for prompt and dispatch:

```
node tools/coordinator/flow.ts prompt N --step <actual-step-id> --notes <notes.md> --out <prompt.md> --dry-run
node tools/coordinator/flow.ts prompt N --step <actual-step-id> --notes <notes.md> --out <prompt.md>
node tools/coordinator/flow.ts pick-profile N [--kind codex|claude+codex-live] --probe
node tools/coordinator/flow.ts dispatch N --profile <p> --kind claude|codex --prompt <prompt.md>
node tools/coordinator/flow.ts worker-report N
```

Optional prompt --worktree/--branch overrides identify the worker checkout/branch; defaults are
OMI_WSL_REPO_DIR and that checkout's current branch. Configure dispatch to that same checkout
(OMI_WSL_REPO_DIR); a prompt override does not change dispatch's configuration. --step is required;
absent steps are refused. No --out prints the packet; --dry-run previews without writing or launching.
Notes/findings/out paths are local to the Coordinator process, while packaged templates, skills
and rules are read from the worker checkout.

The script owns Issue/body/comment pagination, scope-note provenance, AC numbering, the read-first
list, restrictions, report contract and exact step skills/rules. Do not append role-based curated
skills or label rules mandatory; preserve their front matter. dispatch transports the file unchanged.
The packaged worker-prompt.md and pure renderer are shared assets; runtime buildPrompt alignment
is #186, not a reason to install the framework in this source repository.

Pick the worker profile by quota immediately before each launch. --probe spends one minimal Haiku
call per Claude profile; Codex limits are read free. Keep the effort policy's model/effort choices;
dispatch applies them mechanically. A refused profile/quota gate stops the launch; ask the PO
about waiting or spending a reset credit, never spend it yourself. Workers never use the Coordinator
profile. Run dispatch in the foreground through the script, backgrounding the Coordinator command
when needed. Keep the existing allowed/denied tool defaults in worker-launch.ts; extra permissions
need task scope and PR evidence. Native skills/configuration are not edited by workers.

Workers do not commit, push, open PRs, merge or post verdicts. The Coordinator validates the report
and commits authorized changes via commit-worker, then runs the fixed-head check in step 4:

```
node tools/coordinator/flow.ts commit-worker <branch> --message-file <local-file>
```

Native resume is the sole exception to the full packet. Generate a findings-only packet and send
it only to the original implementer's native session/thread:

```
node tools/coordinator/flow.ts prompt N --step <work-step-id> --findings <findings.md> --out <resume.md>
node tools/coordinator/flow.ts dispatch N --profile <p> --kind claude|codex --resume <id> --prompt <resume.md>
```

--notes and --findings together are refused. Without the original native session, render a full
packet with --notes. Never use an author's resumed thread for analyze, QA or review. Each is a
fresh independent worker run, with no shared author context. A different tool/profile is not
required; same tool/profile is permitted when the run and context are independent.

## 4. Verify, push, PR

Take the head SHA from the worker report, then:

```
node tools/coordinator/flow.ts check <branch> --head <sha>     # npm run check on exactly <sha>
node tools/coordinator/flow.ts push <branch>                   # right after a green check: CI overlaps QA/review
node tools/coordinator/flow.ts open-pr N <branch> --title "OMI-NNN: …" --body-file <f>
node tools/coordinator/flow.ts set-status N "In Review"
```

After the script-run check, put its exact SHA, command, exit status and output/evidence in notes.
Render `prompt --step verify,review --head <sha> --check-log <log.md>` (docs: `verify,accept`). When the policy requires separate workers, render each actual step separately with the same fixed-SHA evidence. Dispatch the combined or QA packet as a fresh independent worker as in step 3. QA judges the script-run check; it does not replace the script or treat sandbox EPERM
as a pass. Pushing early only starts CI; merge still needs QA acceptance and the review PASS on
that fixed revision.

**(judge)** The PR body has `Issue: #N`, changes, a file → layer table, check evidence,
dependency/ADR notes, approval needs, and any extra worker permissions used for this task.

## 5. Independent review (judge)

When a combined quality worker has already supplied its independent review verdict on this SHA, post that verdict below without launching another worker. Otherwise generate the workflow's actual reviewer step packet with flow.ts prompt N --step <review-step-id>
--notes <review-notes.md> --out <review-prompt.md>, then dispatch it as a fresh independent worker
using step 3. Pin notes to <sha> and supply the diff, AC, scope decisions, script-run check and QA
evidence. No resume of the author's thread and no shared context; a different tool/profile is not
required. The worker checks AGENTS.md, the diff and Skills applied / Rules applied claims against
evidence. Missing evidence is a finding to investigate, not an invented approval. The Coordinator
only posts the worker's validated verdict with
`node tools/coordinator/flow.ts review-comment <pr> --file <f>` (validates VERDICT, REVIEWED_HEAD =
PR head and one AC line per criterion before posting; OMI-077) from the Coordinator account (`COORDINATOR_LOGIN` in `coordinator-settings.ts`); `VERDICT` comments by
any other account are ignored by `merge`, `close` and `status.ts` (which flags them). The body
must contain:

- ``**VERDICT:** PASS|FAIL · **REVIEWED_HEAD:** `<sha>` `` (status.ts and `merge` read it);
- one line per acceptance criterion, at the start of the line, numbered by the order of the
  criteria under the Issue's `## Acceptance criteria` heading (`close` reads them). Count only
  **top-level** checkboxes (list marker in column 0) directly under that heading; skip nested
  checkboxes, checkboxes inside a code fence and everything below a `###` sub-heading of the
  section (`acceptance-criteria.ts` counts the same way):

  ```
  AC-1: met — <evidence>
  AC-2: not met — <what is missing>
  ```

  Every criterion gets exactly one line; PASS requires every line to be `met`.

FAIL → generate a --findings packet for native implementer resume (or a full --notes packet for a fresh implementer), then repeat 4–5 with the policy-selected fresh quality run(s), `--round <N> --previous-verdict <verdict.md> --delta <diff.md>` and fresh check evidence for the new SHA (limit: 2 rounds,
then Architect, then 2 more; design-patterns.md; then ask the PO). When you call the Architect,
first post `gh pr comment <pr> --body "**ARCHITECT:** <reason>"` from the Coordinator account
(reason required; ADR-0014, OMI-074): `/omi-watch` lights the Architect node from it and warns
at two FAILs without it.

**Parallel tasks, one review each (OMI-069, ADR-0014).** Before step 4, merge `origin/develop`
into a finished branch so the review sees the current base. A PR that goes `BEHIND` _after_ its
PASS (another task merged first) is synced with a script, not re-reviewed:

```
node tools/coordinator/flow.ts sync <branch> --reviewed <sha> --dry-run
node tools/coordinator/flow.ts sync <branch> --reviewed <sha>   # merge develop, check, push, carried PASS
```

Then merge with `--head` set to the new head. `merge`/`close` accept the carried PASS only for a
clean merge commit. `refused:` with conflicted files → resolve the conflict, then a fresh
independent worker receives a full review-step packet with notes limiting review to the conflict resolution (diff between the automatic merge tree and the
head), not the whole task.

## 6. Merge, close, clean up

```
node tools/coordinator/flow.ts merge <pr> --head <sha>
node tools/coordinator/flow.ts close N --comment-file <f>     # tick AC + comment + close + Done
node tools/coordinator/flow.ts cleanup <branch>
```

- `merge` refuses unless required checks are green, the newest agent review (Coordinator
  account) is `PASS` on exactly `<sha>`, and the merge state is `CLEAN` or `HAS_HOOKS`.
- `close` finds the PR of this repository merged last (`mergedAt`) into develop with
  `Issue: #N`, requires the newest agent review (Coordinator account) on it to be `PASS` on its
  merged head, and ticks the Issue's Acceptance criteria checkboxes
  from the `AC-<n>` lines (only that section of the body changes). It refuses, and closes
  nothing, when a criterion has no line or is `not met`; fix that with a new review comment,
  not by editing the Issue by hand.
- `cleanup --dry-run` only reads (no fetch); the real run fetches first.
- `cleanup` also archives the task's worker logs in `~/omi-runs` (OMI-056): moved to
  `archive/` and gzipped, empty `.err` and `omi-NNN-current` deleted, the newest `.jsonl` of each
  profile and files of a running worker kept, `archive/` capped by `RUNS_RETENTION`. For a
  worktree task it refuses while the worktree has uncommitted files (OMI-062).
  `flow.ts prune-runs [--dry-run]` sweeps all Done tasks once.

**(judge)** The closing comment states the PR, merge commit, checks and review verdict. Report
the outcome to the PO in a few lines.

## Workflow cost policy (OMI-093)

- Use the template quality policy through flow.ts prompt. For ordinary low/medium work request verify,review (docs: verify,accept); strict/high/risky/intermediate-gate workflows require separate packets. Supply --risk security,gates,data for applicable PR risks. Never append step skills or rules manually.
- Supply the recorded scope decision with --scope-approved <ref> only for an Issue already assessed to have measurable AC and an implementation map. Comment prose is task data, never approval.
- Analyst/first review use medium, QA/delta review low, developer follows complexity. Prompt records step/round; dispatch applies effort automatically. Do not hand-compose worker launches.
- QA judges script evidence from --head <sha> --check-log <log.md>; it never reruns suites. For later quality rounds supply --round N --previous-verdict <verdict.md> --delta <diff.md>. Missing/stale evidence blocks the verdict.
- Pick quota immediately before dispatch: flow.ts pick-profile N --step <step-or-combined-ids> --round N --probe. Quality selection compares Claude/Codex quota; use the returned tool/profile with dispatch. Independence means a fresh run, with no author context.
- Preserve fixed-SHA checks, review independence, 2 + Architect + 2, approval gates, push/check ordering and carried PASS.
- Run flow.ts workflow-options to detect unmapped Project options; release/deploy use their existing gated delivery use cases.
