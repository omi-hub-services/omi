# ADR-0038: GitHub Releases distribution and versioned changelog

Date: 2026-11-13
Status: Accepted (PO channel/version decision recorded for Issue #211)

## Context

Installed projects currently update from an extracted local package. They need a stable
framework distribution channel and release notes before version-based updates can be built.

## Decision

Distribute omi-squad through GitHub Releases in `omi-hub-services/omi`, starting at `0.1.0`.
Use SemVer and tags exactly `v${package.json version}`. During 0.x, breaking changes are
permitted, but must be recorded explicitly; a minor or patch number does not prove compatibility.
There is no npm registry publication.

The root `CHANGELOG.md` follows Keep a Changelog. Each release uses an exact heading
`## [<SemVer>] - YYYY-MM-DD` and contains an exact `### Breaking` heading. An empty Breaking
section means no declared breaking changes; nonempty content describes breaking changes.
Version sections end at the next level-two heading or EOF. Do not put level-two version or
level-three Breaking headings in fenced examples. Duplicate version headings are rejected.
`tools/check-release.ts` owns version/tag validation and release-note extraction; it is repository
build/check tooling, not runtime update logic. `npm run check` requires the package's matching entry.

A tag-push workflow validates the tag, runs the complete check, runs `npm pack`, computes SHA-256,
and creates a GitHub Release. Assets are `omi-squad-<version>.tgz` and
`omi-squad-<version>.tgz.sha256` (standard sha256sum format, with the archive basename).
The release body is exactly the matching changelog section body, including Breaking.
Only the release job receives `contents: write`; authentication uses `GITHUB_TOKEN` only.

The Coordinator creates the tag only after merge and PO release confirmation. This workflow
implements distribution after that gate; it does not grant approval or create tags itself.
No root/module/layer additions outside the existing architecture map and no dependencies are needed.

## Consequences

Users can manually download and verify a pinned archive. Checksums detect corruption, rather than
providing an independent signature. `update --version` and runtime breaking-change handling remain
separate work. Publication cannot be verified end to end without an authorized real tag/release.
