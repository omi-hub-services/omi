---
name: omi-watch
description: Open the small omi-squad watch window (running WSL workers and live profile quota) in an Edge app window. Use when the PO asks to watch workers/quota, open the monitor, or types /omi-watch.
---

Installed from `templates/bridges/repository/omi-watch/SKILL.md`; edit the template only (ADR-0036).

# /omi-watch

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

Launch only; do not read or summarise worker or quota data yourself (the window shows it).

1. From the repository root (Windows), start the server detached so it outlives this session:

   ```powershell
   Start-Process node -ArgumentList "`"$coordinatorPin/tools/coordinator/watch-web.ts`"",'--open' -WindowStyle Hidden -WorkingDirectory (Get-Location)
   ```

   `--open` opens `http://127.0.0.1:4317` as an Edge `--app` window (default browser if Edge
   is missing). If a watch server already runs on that port it only opens another window.
   The server exits by itself 60 s after the last window closes (OMI-067, ADR-0014).

2. Reply with one line: `watch: http://127.0.0.1:4317 (window opened)`. If no window
   appears, run `node "$coordinatorPin/tools/coordinator/watch-web.ts" --open` in the foreground once and
   report its error. Terminal fallback: `node "$coordinatorPin/tools/coordinator/watch.ts"`.
