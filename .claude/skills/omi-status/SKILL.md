---
name: omi-status
description: Show the omi-squad delivery status (Project items by Status, unblocked Ready tasks, open PRs with checks/review, WSL workers, worker quota) and recommend the next task. Use at the start of a Coordinator session or when asked "what's the status / what's next".
---

Installed from `templates/bridges/repository/omi-status/SKILL.md`; edit the template only (ADR-0036).

# /omi-status

Before any business command, resolve the verified external tooling checkout from the host
repository root (PowerShell). Keep this directory as the working directory for every command;
`OMI_WSL_REPO_DIR` still selects the task's WSL work checkout. Do not change it to the pin.

```powershell
$coordinatorPin = $env:OMI_COORDINATOR_PIN_DIR
if ([string]::IsNullOrWhiteSpace($coordinatorPin)) {
  $coordinatorPin = Join-Path (Split-Path (Get-Location).Path -Parent) 'omi-coordinator-pin'
}
if (-not [System.IO.Path]::IsPathRooted($coordinatorPin)) { throw 'Coordinator pin path must be absolute' }
$pinJson = node "$coordinatorPin/tools/coordinator/pin.ts" status
if ($LASTEXITCODE -ne 0) { throw 'Coordinator pin status refused' }
$pinStatus = $pinJson | ConvertFrom-Json
if (-not $pinStatus.initialized) { throw 'Coordinator pin is absent, dirty or mismatched; run the ADR-0036 first-install/refresh procedure' }
$coordinatorPin = $pinStatus.checkout
```

The bootstrap executes only the installed pin, including its status command. All business commands below use
the pin; never fall back to flow/status/watch from the working develop checkout. Resolve the pin
again after a refresh or rollback. Pin mutations run between commands, never during a live
Coordinator import. A refusal is a gate, not permission to run the moving source copy.

Data collection is a script; do not re-derive it with `gh`/`git` calls (AGENTS.md §9).

1. From the repository root run:

   ```
   node "$coordinatorPin/tools/coordinator/status.ts"
   ```

   Use `--json` only if you need a field the text omits. If the script fails (e.g. `gh` not
   logged in), report the error line and stop; do not fall back to manual queries.

2. Reply in at most ~10 lines:
   - counts per Status, and what is In Progress / In Review / Blocked / Waiting;
   - open PRs: checks state, whether the agent review is `PASS @head`, missing `Issue:` link;
   - "Attention" lines (Status and Issue state disagree) and running or finished workers
     (a finished log with an error, or a stale log with no worker process, needs action);
   - quota: one short line per profile from the "Quota" section (5h/7d left, data age);
     say when no profile is above the thresholds and when the next reset is. Claude numbers
     come from the OAuth usage endpoint (OMI-065, ADR-0033), falling back to worker logs
     (then they may be old or `unknown`); mention a per-model weekly window (e.g. Fable) when
     shown; `/omi-next` probes before dispatch;
   - **Recommendation:** one next action with a one-line reason. Priority: finish work already
     in flight (merge a green, reviewed PR; resume a stopped worker) before starting a new task;
     otherwise the first entry under "Ready, all blockers closed", or when that is empty the
     first under "Backlog, all blockers closed" (`/omi-next` promotes it), unless something in
     the status argues against it (say what, e.g. no worker quota until a reset).

3. Do not change anything. Starting the task is `/omi-next [OMI-xxx]`.

For a live view between status reads, the PO can keep `node "$coordinatorPin/tools/coordinator/watch.ts"`
(OMI-064) open in a small terminal pane: running workers and quota, refreshed in place.
