# ADR-0024 — Git workspace identity, reservations and safe cleanup

- Status Accepted
- Date 2026-11-11
- Issue #25 (OMI-021)
- References architecture.md §3.3, §4, §8–§10, design-patterns.md §8, ADR-0012 and ADR-0018

## Decisions

1. `GitWorkspace` owns local task workspace operations. Its CLI adapter uses bounded,
   synchronous `spawnSync` calls with argument arrays, shell disabled, hooks disabled and
   ambient `GIT_*` overrides removed. Process output stays inside infrastructure. Fixed
   error codes cross the port. Synchronous operations match the existing lease store and
   keep this local-only adapter small. Runtime dispatch and process supervision belong to
   their existing boundaries.
2. A task identity consists of `omi-NNN` and a lowercase hyphenated slug. The branch is
   `task/omi-NNN-slug`, created at the pinned local `refs/heads/develop` commit. The default
   workspace is `<main-parent>/<main-name>-worktrees/omi-NNN-slug`. Configuration may choose
   another sibling root. Canonical main paths and rejection of symlink workspace/root paths
   prevent aliases from producing different lease keys or directing cleanup elsewhere.
3. The shared project `LeaseStore` uses the existing `worktreeLeaseKey(canonicalPath)`.
   Creation, cleanup and writer acquisition compete for the same reservation. Nested claims,
   including the same owner, fail. A writer holds the reservation until explicit release.
   Expiry alone cannot prove its process stopped. The lease port gains optional
   `reclaimExpired`, defaulting to the existing takeover behavior. Git passes `false`.
   Explicit release records expiry equal to acquisition, retaining owner and fencing
   generation. An acquired lease always has strictly later expiry, so this marker uses the
   existing schema and distinguishes a release from a timeout. Release also marks an expired
   lease. Recovery can release its known owner/generation after confirming the old process
   stopped. Renewal and stale-release checks retain existing fencing semantics.
4. A matching registered branch/worktree is the reconciliation result for creation retries.
   A conflicting path or branch is preserved and refused. A partial Git failure can leave
   its branch or registration for explicit inspection/recovery. Automatic rollback would
   risk deleting work created after the command started. Cleanup retries succeed when the
   registration and directory are both absent. Task branches are retained after removal.
5. Dirty inspection includes staged, unstaged, untracked and submodule changes. Ignored files
   are reported separately, allowing normal ignored dependencies in the user's checkout.
   Index flags that hide changes are cleared only in a temporary index copy before inspection.
   Absent sparse-checkout entries keep their skip flag. The user's index and flags are preserved.
   Creation refuses a dirty main checkout. Cleanup refuses dirty tasks and ignored files,
   since Git can delete ignored files even without force. Cleanup also requires task HEAD
   ancestry in both local `develop` and fetched `origin/develop`. Missing remote evidence
   refuses cleanup. These checks intentionally retain squash/rebase-merged task worktrees
   whose original commits have no ancestry proof. No stash, reset, branch deletion or force
   operation occurs.
6. This adapter performs local operations. The runtime must refresh remote-tracking refs
   before requesting cleanup and keep all callers on the shared project lease store. Remote
   reconciliation, worker termination and recovery orchestration remain with their owning
   use cases. Local reservations coordinate cooperating callers. Concurrent edits or ref
   rewrites by processes bypassing the runtime remain outside that coordination boundary.

## Consequences

No dependency, structure-map or migration change is needed. Existing lease callers retain
expired takeover by default. Tests exercise real repositories, a local bare origin and
separate SQLite connections/processes in OS temporary directories. Application callers
receive workspace data, lease fences and typed failures through the port.
