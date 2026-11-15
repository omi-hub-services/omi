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
$pinGuard = @'
/* global process, console */
// Embedded verbatim in installed skills: only Node built-ins run before checkout isolation.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function runPinStatus(root, env, defaults, execute = execFileSync) {
  if (defaults.length !== 3 || defaults.some((value) => typeof value !== "string" || !value))
    throw new Error("PIN_DEFAULTS_INVALID");
  const host = fs.realpathSync(root);
  const requested = env.OMI_COORDINATOR_PIN_DIR ?? path.join(path.dirname(host), defaults[0]);
  if (!path.isAbsolute(requested)) throw new Error("PIN_PATH_MUST_BE_ABSOLUTE");
  const checkout = fs.realpathSync(requested);
  let work = env.OMI_WSL_REPO_DIR ?? defaults[1];
  if (process.platform === "win32" && work.startsWith("/")) {
    work = `\\\\wsl.localhost\\${env.OMI_WSL_DISTRO ?? defaults[2]}${work.replaceAll("/", "\\")}`;
  }
  if (!path.isAbsolute(work)) throw new Error("PIN_WORK_PATH_MUST_BE_ABSOLUTE");
  const targets = [host, fs.realpathSync(work)];
  for (const target of targets) {
    if (contains(checkout, target) || contains(target, checkout))
      throw new Error("PIN_CHECKOUT_OVERLAPS_WORKTREE");
  }
  const entry = fs.realpathSync(path.join(checkout, "tools/coordinator/pin.ts"));
  if (!contains(checkout, entry)) throw new Error("PIN_ENTRYPOINT_OUTSIDE_CHECKOUT");
  for (const target of targets) {
    if (contains(target, entry)) throw new Error("PIN_ENTRYPOINT_OVERLAPS_WORKTREE");
  }
  let status;
  try {
    status = JSON.parse(
      execute(process.execPath, [entry, "status"], {
        cwd: host,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        env: { ...env, OMI_COORDINATOR_PIN_DIR: checkout },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    throw new Error("PIN_STATUS_FAILED");
  }
  // Never let a selected entry point redirect the already validated business-command path.
  if (
    status === null ||
    typeof status !== "object" ||
    status.initialized !== true ||
    typeof status.checkout !== "string"
  )
    throw new Error("PIN_STATUS_INVALID");
  if (path.relative(checkout, fs.realpathSync(status.checkout)) !== "")
    throw new Error("PIN_STATUS_INVALID");
  return checkout;
}
module.exports = { runPinStatus };

if (require.main === module || process.argv[1] === "-") {
  try {
    process.stdout.write(runPinStatus(process.cwd(), process.env, process.argv.slice(2)));
  } catch (error) {
    console.error(`pin bootstrap: refused: ${error.message}`);
    process.exitCode = 1;
  }
}
'@
$coordinatorPin = $pinGuard | node --input-type=commonjs - 'omi-coordinator-pin' '/home/ttin/github/omi' 'Ubuntu-24.04'
if ($LASTEXITCODE -ne 0) { throw 'Coordinator pin isolation/status refused; use the ADR-0036 first-install/refresh procedure' }
```

The embedded guard uses only Node built-ins to canonicalize the host checkout, WSL work target,
configured pin and entry point. It rejects overlapping paths and symlink aliases before executing
any selected checkout code. It then checks initialized status without accepting a redirected
checkout path from that entry point. All business commands below use
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
