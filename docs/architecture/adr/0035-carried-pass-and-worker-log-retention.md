# ADR-0035 — Carried PASS over a clean sync and worker log retention

- Status: Accepted
- Date: 2026-11-12
- Issue: #163 (OMI-080), epic #50
- Context: ADR-0014 (Coordinator rules 069 carried PASS and 056 log retention, the reference),
  ADR-0034 (task PR merge gates), architecture.md §11

## Context

A PR with a PASS falls BEHIND whenever another task merges first. Re-reviewing every sync wastes
reviews; trusting a comment that says "carried" would let anyone launder a PASS. Worker logs also
grow without bound. The Coordinator tooling already solved both for this repository; the framework
needs the same behaviour behind ports.

## Decision

1. **Carried PASS is judged from git, never from stored text.**
   `domain/delivery/carried-pass-policy.ts` (`judgeCarriedHead`): the head is a merge commit whose
   first parent is the reviewed commit, whose second parent is on the base branch, and whose tree
   equals the automatic merge (`git merge-tree --write-tree`) of both parents.
2. **Use case** `carryPassOverSync` (`application/use-cases/delivery/`): needs a valid PASS on the
   head, a clean worktree and runtime commands for the required checks; merges the base through
   `BranchSync` (`infrastructure/git/cli-branch-sync.ts`); re-runs each required check on the new
   head with `CheckRunner`; only then pushes (never forced) and stores the record
   (`carried-pass/<new head>.json`: old head, new head, base commit, merge tree, check evidence) as an
   artifact. A conflict changes nothing and returns the conflicted files: only the resolution needs
   a new review. A failing check leaves the merge commit local and unpushed.
3. **The merge gate** (`mergeTaskPr`) takes an optional `carry` dependency. Without a review on the
   head it walks first parents (at most 20 hops): every hop must be a clean sync, and the walk must end
   at a direct PASS. The review is then pinned to the head and to the newest merged base commit, so
   moving `develop` again makes the PR stale and behind again. No new table: the artifact is audit
   evidence, git is the authority. Skipping review for conflicted PRs stays out of scope.
4. **Worker log retention** is a pure policy (`domain/runs/log-retention-policy.ts`): logs of Done
   tasks are gzipped into `archive/`, except running workers' logs, files written within
   `recent_minutes` and the newest stream log of each profile; `archive/` then drops files older than
   `archive_max_age_days` and the oldest until at most `archive_max_bytes`. `retainWorkerLogs` applies
   it through `WorkerLogStore` (`infrastructure/artifacts/directory-worker-log-store.ts`), skips files
   that vanished, and reports files that failed.
5. **Layout and naming.** Logs live in `.omi-squad/local/logs/`, apart from the immutable run
   artifacts. A log is named `<taskId>--<rest>`; a stream log is `<taskId>--<profile>--<timestamp>.jsonl`.
   Other files are never touched. Settings: optional `log_retention` in `project.yaml`
   (`recent_minutes` 30, `archive_max_bytes` 50 MiB, `archive_max_age_days` 30).
6. **Triggers.** `mergeTaskPr` calls an optional `afterDone(taskId)` once the task is recorded Done;
   its failure never undoes or hides the merge. Manually: `omi-squad prune-logs --project <path>
[--task <id>...] [--dry-run]`.

## Consequences

- Running workers are known only if the caller supplies them (`running`); the container passes none, so
  until the runtime writes worker logs itself, the `recent_minutes` window is what protects a live log.
- The runtime does not write logs into `.omi-squad/local/logs/` yet; the naming above is the contract
  a writer must follow.
- `omi-squad prune-logs` takes Done task ids from the caller; it does not read task status.
