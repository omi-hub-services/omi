---
name: omi-watch
description: Open the small omi-squad watch window (running WSL workers and live profile quota) in an Edge app window. Use when the PO asks to watch workers/quota, open the monitor, or types /omi-watch.
---

Installed from `templates/bridges/repository/omi-watch/SKILL.md`; edit the template only (ADR-0036).

# /omi-watch

Launch only; do not read or summarise worker or quota data yourself (the window shows it).

1. From the repository root (Windows), start the server detached so it outlives this session:

   ```powershell
   Start-Process node -ArgumentList 'tools/coordinator/watch-web.ts','--open' -WindowStyle Hidden -WorkingDirectory (Get-Location)
   ```

   `--open` opens `http://127.0.0.1:4317` as an Edge `--app` window (default browser if Edge
   is missing). If a watch server already runs on that port it only opens another window.
   The server exits by itself 60 s after the last window closes (OMI-067, ADR-0014).

2. Reply with one line: `watch: http://127.0.0.1:4317 (window opened)`. If no window
   appears, run `node tools/coordinator/watch-web.ts --open` in the foreground once and
   report its error. Terminal fallback: `node tools/coordinator/watch.ts`.
