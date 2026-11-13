# Project-local packaging, installation and updates

The distribution is a versioned npm tarball containing `dist/`, `templates/`, `schemas/`,
`migrations/` and npm's package metadata/README/license. Build before `npm pack`; `npm run check`
builds and runs `pack:check` against a real archive. No registry publication or global framework
installation is required. Node 24.22.2 and npm must already be available in WSL2. Windows needs
Node for the installed Windows entrypoint and the existing managed session launcher (ADR-0012,
ADR-0030). The checkout must be on the Linux filesystem, bound to one named WSL2 distro.

## Download a GitHub Release manually

Releases are distributed at https://github.com/omi-hub-services/omi/releases, starting at
SemVer 0.1.0. Select a specific version and read its release notes, especially Breaking.
During 0.x, breaking changes are allowed and must be recorded; version numbers alone do not
promise compatibility. See [ADR-0038](../architecture/adr/0038-github-release-distribution.md).

Download both assets from the same release into an empty directory in WSL2:

```sh
curl --fail --location --remote-name https://github.com/omi-hub-services/omi/releases/download/v0.1.0/omi-squad-0.1.0.tgz
curl --fail --location --remote-name https://github.com/omi-hub-services/omi/releases/download/v0.1.0/omi-squad-0.1.0.tgz.sha256
sha256sum --check omi-squad-0.1.0.tgz.sha256
```

Stop if verification fails. Use the verified archive's absolute path in the bootstrap below.
The checksum detects corruption; it is not an independent signature. The release body contains
that version's changelog section, including an empty or populated `### Breaking` section.
No registry publication is involved. Version-based update/download is separate work; the current
update still takes an extracted package through `--package`.

Maintainers: update package.json and package-lock.json together, add the matching dated changelog
entry with Breaking, and run `npm run check`. After merge and PO release confirmation, the
Coordinator pushes the matching version tag. The tag workflow validates it, checks, packs and
publishes the tarball and checksum using only GITHUB_TOKEN. Do not create a release as part of
ordinary implementation or treat a tag's existence as PO approval.

## Bootstrap from a local archive

Perform these commands in WSL2, outside the framework source repository. Supply an absolute
project directory that already exists and the distro name shown by `wsl.exe --list --verbose`.
The temporary bootstrap is separate from the application and can be removed after installation.
Do not install the framework globally or change the application's package manifest.

```sh
bootstrap=$(mktemp -d)
npm install --prefix "$bootstrap" --global=false --no-audit --no-fund /absolute/omi-squad-0.1.0.tgz
package="$bootstrap/node_modules/omi-squad"
node "$package/dist/bootstrap/cli.js" install --project /home/user/project --distribution Ubuntu-24.04 --package "$package" --json
# Review the preview, then apply the same arguments:
node "$package/dist/bootstrap/cli.js" install --project /home/user/project --distribution Ubuntu-24.04 --package "$package" --apply --json
/home/user/project/.omi-squad/bin/omi doctor --project /home/user/project --distribution Ubuntu-24.04 --json
```

The package argument is an **extracted package directory with its built assets**. The installer
packs that directory with lifecycle scripts disabled, retains the tarball under `.omi-squad/tool/`,
and installs it with normal npm dependency/native-module setup. The tool manifest and npm lock
refer to the retained relative tarball, so they do not depend on the bootstrap directory. The
framework lock pins the version, artifact content hash, distro, project path and original template
contents. No source files, application dependencies or native Claude/Codex settings are installed.
Ignore `.omi-squad/local/` and `.omi-squad/tool/node_modules/` in the target project's Git setup;
keep its framework lock, shims, tool manifest/lock/tarball and project template files versioned.

From Windows, use the installed shim through its UNC path:

```powershell
node '\\wsl.localhost\Ubuntu-24.04\home\user\project\.omi-squad\bin\omi.cjs' status --json
node '\\wsl.localhost\Ubuntu-24.04\home\user\project\.omi-squad\bin\omi.cjs' session start
```

Ordinary calls use `wsl.exe --distribution … --cd … --exec <project-shim>` with an argv array.
`session start` invokes the existing Windows lifecycle launcher, which owns the WSL runtime pipe
and starts the Windows Coordinator. The installed launcher refuses attempts to replace its bound
project/distro/runtime options. Credentials and native modules remain on their respective sides.

`doctor` checks the WSL2 kernel, current and registered distro version, interop registration/socket,
Linux filesystem checkout, reversible UNC path mapping, and a Windows-to-WSL local shim invocation.
It fails when evidence is missing. JSON output is versioned and the process returns nonzero on
failure. This is the packaging diagnostic scope; it does not claim to probe all GitHub permissions,
subscription profiles or external tool compatibility.

## Updates and conflicts

Run the same bootstrap steps with the new archive, replacing `install` with `update`. Both commands
preview by default and require `--apply` for writes. They share one implementation. Stop the managed
session first. Live or unreconciled project-owner leases prevent updating; changing a project's distro
or location is refused. Installers serialize through a private operation directory and compare the
snapshot again after provisioning so edits made while npm runs are preserved.

The three-way comparison uses old template / incoming template / local file. An untouched file
follows upstream; a local override remains when upstream is unchanged; identical edits converge.
Divergent edits, upstream deletion of an edited file, and upstream changes to a locally deleted file
are conflicts. Conflicts list paths and change nothing. This is a conservative whole-file merge;
it does not guess how to merge overlapping YAML/Markdown. Resolve a conflict by making the local
file equal to the incoming version or restoring the old base before retrying. Preserve custom
content separately when choosing an upstream version. Files outside the template manifest remain
project-owned. Templates under both `templates/project/.omi-squad/` and the existing onboarding
`templates/project/workflows/` map to the same project `.omi-squad/` tree; duplicate targets fail.

The preview also lists `bridge/CLAUDE.md`, `bridge/AGENTS.md`, and `bridge/skill/*`. Instruction
keys represent only the `<!-- omi-squad:start -->` / `<!-- omi-squad:end -->` span in the root
files, so the same three-way merge preserves text outside that span. Skill keys target
`.claude/skills/omi-squad/{SKILL.md,bridge.ts,bridge.config.json}`. The config binds the project,
distro and local shim. Local skill/span edits are kept while upstream is unchanged; divergent
updates conflict. Invalid/duplicate markers or symlinked targets are refused before provisioning.

## Migration backup and recovery

Before upgrading state, the installer takes a SQLite backup through the backup API (including
committed WAL data), checks integrity, and backs up config, template bytes, shims and prior tool
manifests in `.omi-squad/local/backups/install-<id>/`. Existing config is parsed through the existing
strict v1 loader. The only current config normalization materializes the already-supported default
`effort_policy` when absent, preserving existing comments and explicit policies. Unknown schema
versions are refused. No hypothetical legacy schema conversion or automatic schema downgrade is
provided. Runtime startup also takes a SQLite backup before pending migrations.

Bridge backups contain full original instruction files at `bridge/CLAUDE.md` / `bridge/AGENTS.md`
and skill files under `bridge/skill/`. For recovery, map those back to root instructions and
`.claude/skills/omi-squad/` respectively. They are not paths under the target `.omi-squad/` tree.

SQL upgrades reuse the existing checksummed transactional migration runner. A SQL failure rolls
back that migration batch and leaves the old tool and project files active. Dependency provisioning
or snapshot validation failures also leave the old tool/files active. The pre-install bootstrap
migration that creates the owner-lease table may remain on a previously empty database.

Filesystem publication and SQL are not a single crash-atomic transaction. A process kill or disk
failure during publication may require manual recovery; do not assume that rerunning an older binary
can downgrade state. Stop all runtime/worker/installer processes and establish that no writer remains.
Keep the failed tree and backups for diagnosis. Restore the matching config/templates/shims and tool
manifests together with the backup database, removing the old live database's WAL/SHM only after all
connections have closed. Reinstall the matching framework artifact/dependencies; never copy native
modules from Windows. Check integrity and reconcile the restored owner lease/recovery state before
resuming. The backup may contain the installer's lease, so it must not be treated as a live owner;
normal runtime recovery can reclaim an expired lease. A stale `local/tmp/installation.lock` is removed
only after confirming the installer exited. Backups are local and are not a disaster-recovery promise.

Offline e2e tests extract real tarballs, simulate dependency provisioning using already-installed test
dependencies, and exercise real SQLite/Unix shims. A dependency-free fixture separately exercises real
npm pack/install and relative tarball locks offline. WSL diagnostic inputs and Windows process argv
are simulated. Actual clean WSL2 native-module installation and Windows/WSL lifecycle/UNC behavior
still require opt-in platform acceptance; these tests do not claim that evidence.

## Current reconciliation (2026-11-13)

[CLI verification](cli-verification.md) records built install/update previews from a copied package, source-target refusals, and successful init apply in a
`.tmp/` project. It does not repeat a full dependency install or Windows acceptance. Bridge keys
also include Coordinator-only `omi-status`, `omi-next`, `omi-watch` skills, in addition to the
`omi-squad` bridge (`src/infrastructure/config/` installation adapters and `templates/bridges/`).
The source-maintenance variants live in `templates/bridges/repository/` and use the external
Coordinator pin (ADR-0036); installing the product runtime in this source repo is prohibited.
