# ADR-0044: Local settings credential boundary

Status: Accepted · 2026-11-15 · OMI-155 (#319)

## Context

ADR-0043 validates Claude subscription setup-tokens and a shared worker GitHub PAT.
The approved settings design requires one gitignored file with clear editor descriptions.
This replaces ADR-0022's “framework holds no secret” boundary for those two token types;
all other credential guards and approval gates remain in force.

## Decision

`application/contracts/omisetting.ts` owns the strict version-1 contract and generated
`schemas/omisetting.schema.json`. `infrastructure/config/load-omisetting.ts` reads only
`.omi/omisetting.local.json`, bounds file size, rejects symlinks and reports fixed reasons
with field paths, never input values or JSON parser excerpts. The optional Docker block
is configuration documentation only; Docker execution belongs to #320.

Only `github.token` and Claude `profiles[].auth.token` contain static secrets. Tokens are
never sourced from inherited auth environment variables. Each executor selects exactly
one configured profile and injects its token and the shared `GH_TOKEN` into that child
process environment, never argv. Known token values join `CredentialPolicy` for packets,
artifacts, checkpoints, worker output and diagnostics. They must never reach prompts,
logs, state, reports or GitHub. Native CLIs necessarily retain their own session state;
the framework does not copy or serialize authentication files.

The GitHub token belongs to an account other than the PO. Its fine-grained permissions
are Metadata Read; Contents, Pull requests and Issues Read and write; Workflows Read and
write only for workflow changes; organization Projects Read and write (ADR-0043 §4).
Claude tokens come from `claude setup-token`, scope user:inference, and rotate yearly.
No API billing or Codex API-key profile is introduced.

`omi profile login <id>` invokes native Codex browser login with a forced file credential
store at `~/.codex-profiles/<id>` in WSL today, matching the existing profile layout.
Windows PowerShell uses the installed `.omi/bin/omi.cjs` bridge; its typed
`wsl.exe --exec` call opens no WSL shell for the PO. The native Codex login owns browser
interaction. The framework never copies auth from a Windows/global store or into settings.
This writable directory must be the sole live refresh-token store; Docker will replace it
with a dedicated volume in #320. Refresh behavior remains subject to ADR-0043's open item.

Installation creates an example with conspicuously fake values, one field per line,
and preserves existing examples and settings. It adds the exact local-file ignore rule.
Doctor validates settings, refuses git-tracked local settings, and probes configured
credentials without recording native auth output. No new dependencies, layer, module
directory, coordinator tooling or guard exemption is needed.

## Consequences

Settings stay plaintext and require filesystem access protection. The framework cannot
prevent a user or native CLI from deliberately exposing credentials; it rejects configured
values at its own output boundaries. Native login is interactive and opt-in; tests use only
fake binaries in temporary stores. Existing projects without settings retain legacy native
login execution until configured, but doctor reports the missing settings file.
