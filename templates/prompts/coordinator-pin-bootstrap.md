Before any business command, resolve the verified external tooling checkout from the host
repository root (PowerShell). Keep this directory as the working directory for every command;
`OMI_WSL_REPO_DIR` still selects the task's WSL work checkout. Do not change it to the pin.

```powershell
$coordinatorPin = $env:OMI_COORDINATOR_PIN_DIR
if ([string]::IsNullOrWhiteSpace($coordinatorPin)) {
  $coordinatorPin = Join-Path (Split-Path (Get-Location).Path -Parent) '{{pin_directory_name}}'
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
