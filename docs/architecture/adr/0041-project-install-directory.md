# ADR-0041: Project install directory

- Status: Accepted (OMI-153, PO directory rename recorded in the design spec)
- Date: 2026-11-15

The installed project tree moves to `.omi/`. Package/executable names and HTML markers
remain unchanged. Historical ADR text is retained with a status note. This amends the
installation layout in the architecture; no new layer, module directory or dependency is added.

Migration uses the existing project use-case, application port, config adapter and installation
command modules. `migrate-dir` runs `git mv`, refuses an existing destination and rewrites
managed text, lockfile baselines, shims and bridge files. Runtime state and dependency package
bytes remain intact. A subsequent update installs the current runtime. Normal readers never
fall back to the legacy directory; install/update refuse it with the migration hint.
