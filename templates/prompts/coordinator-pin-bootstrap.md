Before any business command, resolve the verified external tooling checkout from the host
repository root (PowerShell). Keep this directory as the working directory for every command;
`OMI_WSL_REPO_DIR` still selects the task's WSL work checkout. Do not change it to the pin.

```powershell
$pinGuard = @'
{{pin_guard}}
'@
$coordinatorPin = $pinGuard | node --input-type=commonjs - '{{pin_directory_name}}' '{{pin_default_wsl_repo}}' '{{pin_default_wsl_distro}}'
if ($LASTEXITCODE -ne 0) { throw 'Coordinator pin isolation/status refused; use the ADR-0036 first-install/refresh procedure' }
```

The embedded guard uses only Node built-ins to canonicalize the host checkout, WSL work target,
configured pin and entry point. It rejects overlapping paths and symlink aliases before executing
any selected checkout code. It then checks initialized status without accepting a redirected
checkout path from that entry point. All business commands below use
the pin; never fall back to flow/status/watch from the working develop checkout. Resolve the pin
again after a refresh or rollback. Pin mutations run between commands, never during a live
Coordinator import. A refusal is a gate, not permission to run the moving source copy.
