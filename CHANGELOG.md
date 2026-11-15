# Changelog

All notable changes to omi-squad are documented here, following Keep a Changelog
and Semantic Versioning. During 0.x, breaking changes are allowed and listed explicitly.
Each version contains a `### Breaking` section; an empty section declares no breaking changes.

## [0.1.1] - 2026-11-15

### Fixed

- OMI-145: commit-worker handles root files.
- OMI-146: repository report entry shape.
- OMI-147: `close` accepts a release PR into `main`.
- OMI-148: pin refresh removes its previous checkout backup.
- OMI-149: Coordinator bridge reached no WSL CLI; `wsl.exe` argument quoting fixed.

### Breaking

## [0.1.0] - 2026-11-15

### Added

- Initial versioned framework distribution through GitHub Releases, with a package tarball,
  SHA-256 checksum and version-specific release notes.
- Project-local installation and updates from an extracted framework package.
- Workflow execution, Coordinator bridges and GitHub delivery tooling.
- Project `install`, `update`, `init` (new and existing repositories) and `doctor`.
- Session and workflow runs with business approvals, pause/resume and durable state across
  session restarts.
- Architect intervention and PO-approved reopen after failed quality cycles.
- Delivery: refresh → verify → review → prepare-pr → review-comment → deliver, merging into
  `develop` and confirming before `done`.
- `prepare-release`, `merge-release` and `publish-release`, with native PO approval on `main`.
- `deploy` with a `project.yaml` allowlist, digest approval and the native environment gate.
- Accepted in the v0.1.0 beta on one new and one existing repository
  (`docs/operations/acceptance/omi-047-beta.md`).

### Fixed

- OMI-118: `doctor` detects WSL interop.
- OMI-119: shim pins `execPath`.
- OMI-120: session launcher node.
- OMI-122: runtime PATH for worker CLIs.
- OMI-123: promote and set-status use the project directory.
- OMI-124: implementation map and Plan Key parsing.
- OMI-125: `workspace.taskId` format.
- OMI-126: stale business approval was accepted after a re-import (P0).
- OMI-127: retry returns a typed refusal.
- OMI-128: `BUSINESS_BASELINE_CHANGED` rebaseline.
- OMI-129: `RESULT_MISSING` from a fenced final message.
- OMI-130: analyze artifact sha; redactor masked git SHAs.
- OMI-131: `artifact_root` kept artifacts out of the worktree.
- OMI-132: runtime runs the checks.
- OMI-133: template archive.
- OMI-134: `TEMPLATE_UNAVAILABLE` retry and template hash.
- OMI-135: skill evidence prompt.
- OMI-136: optional revision fields.
- OMI-137: previous verdict and delta.
- OMI-138: check `evidenceRef`.
- OMI-139: `preparePr` wiring.
- OMI-140: workspace slug versus task id.
- OMI-141: refresh path for a stale review.
- OMI-142: review AC-line validation.
- OMI-143: prepare-release and publish-release wiring.

### Breaking
