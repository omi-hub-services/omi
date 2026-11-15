# ADR-0043: Token-based worker auth

Status: Proposed · 2026-11-15

## Context

Issue #318 (OMI-154) is a spike. Design `docs/superpowers/specs/2026-11-15-omi-dir-settings-docker-design.md`
§2 and Risks assume that workers in Docker authenticate with tokens and volumes, not a host login:
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), a Codex login in `CODEX_HOME` on a named
volume, and `GH_TOKEN`. This ADR records the live checks that tested those assumptions. The
Coordinator ran them on 2026-11-15 with secrets passed by environment only; no secret value,
token prefix or token body appears here. Throwaway code is not kept.

Environment: Windows 11, Docker 29.8.1 (Docker Desktop, used from WSL Ubuntu-24.04). Throwaway
image `omi154-spike`: node:24-bookworm-slim plus git, ca-certificates, curl;
`npm i -g @openai/codex@0.167.0 @anthropic-ai/claude-code@2.1.322`; user `node` (uid 1000).

## Evidence

### 1. Claude token profile (setup-token, Pro subscription)

The token was passed as `docker run -e CLAUDE_CODE_OAUTH_TOKEN` (name only; the value came from
the caller's process env, never argv, image or container config). `CLAUDE_CONFIG_DIR=/profiles/claude`
on volume `omi154-profile-claude`.

- `claude auth status`: loggedIn true, authMethod oauth_token, apiProvider firstParty,
  loginExpiresAt null.
- `claude -p "Reply with exactly: OK" --output-format stream-json --verbose --model haiku`: exit 0,
  result success. The init event shows apiKeySource "none": subscription, not API billing.
  `total_cost_usd` (0.00139) is the CLI's notional figure and is not billed.
- `rate_limit_event` is present: status allowed, rateLimitType five_hour, overageStatus rejected
  (org_level_disabled), isUsingOverage false, and `unifiedWindows` with five_hour utilization 0.57,
  seven_day utilization 0.02 and `resetsAt` for each. It matched the usage-endpoint reading taken
  at the same time (5h 46% left, 7d 98% left).
- `--resume <session_id>` in a new container with the same config volume: success, same
  session_id, the model recalled the earlier reply. Resume works with a per-profile
  `CLAUDE_CONFIG_DIR`.
- `GET https://api.anthropic.com/api/oauth/usage` (Bearer setup-token, `anthropic-beta:
  oauth-2025-04-20`): HTTP 403 `permission_error` / `oauth_scope_insufficient`, required scope
  `user:profile`. The setup-token requests scope `user:inference` only.

### 2. Codex `login` profile in a named volume

Volume `omi154-profile-codex` at `/profiles/codex`, `CODEX_HOME=/profiles/codex`. It was seeded by
copying `auth.json` (auth_mode chatgpt, ChatGPT Plus) and `config.toml` from an existing host
profile (tar through `docker run -i`, chown 1000, chmod 600); no device login was run.

- Run 1 (`docker run --rm`): `codex login status` -> "Logged in using ChatGPT";
  `codex exec --skip-git-repo-check "Reply with exactly: OK"` -> OK, exit 0, 2,209 tokens.
- Run 2 (new container, same volume): same result. Auth survives container recreation.
- `auth.json` hash prefix identical before and after: no refresh happened.
- Token claims: access_token iat 2026-11-10T06:42Z, exp 2026-11-20T06:42Z; id_token exp 1h;
  `last_refresh` 2026-11-10T06:42Z.
- Forced refresh: `last_refresh` set to 2026-11-01 in the volume copy; `codex exec` still worked
  and tokens were not refreshed. Codex 0.167 refreshes on access-token expiry, not on
  `last_refresh` age.

**Automatic refresh is not yet observed.** It is due after 2026-11-20T06:42Z.

### 3. GitHub fine-grained PAT (account minibox-claude-code)

Isolated `GH_CONFIG_DIR`, `GH_TOKEN` by env only, gh 2.103.3, token expires 2027-11-16.
The repository role was admin, so the PAT, not the role, is the limit.

- Original PAT (Contents, Pull requests, Issues read-only): `gh api user` ok; Project v2 draft
  item create, `updateProjectV2ItemFieldValue` (single-select) and delete ok, so organization
  Projects Read and write is sufficient. Denied with 403: git push / create ref
  (needs contents=write, plus workflows=write for workflow files), PR create
  (pull_requests=write), issue comment (issues=write or pull_requests=write).
  Reads of contents, issues and pull requests were ok.
- After the PO set Contents, Pull requests, Issues, Workflows Read and write (plus Metadata read,
  organization Projects Read and write): push of a throwaway branch ok; draft PR create ok
  (#359, closed and branch deleted at once); issue comment create and delete ok; Project v2 draft
  item create, field write and delete ok. No leftovers.

### 4. Cleanup

After the checks, all spike containers, both profile volumes (`omi154-profile-claude`,
`omi154-profile-codex`), the `omi154-spike` image and the tmp files were removed.

## Decisions

1. **Claude token profiles are valid.** `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` runs
   `claude -p` on the subscription, emits `rate_limit_event`, and supports `--resume` with a
   per-profile `CLAUDE_CONFIG_DIR` volume. The token is passed by env name only.
2. **Quota reading for token profiles.** The setup-token cannot read `/api/oauth/usage`
   (403, scope `user:inference` only). Token profiles read quota from
   `rate_limit_event.unifiedWindows` (five_hour and seven_day utilization and `resetsAt`) of each
   worker run, and from a minimal probe run before dispatch (the existing `pick-profile --probe`
   path). The usage endpoint stays only for profiles with a full OAuth login. This amends
   ADR-0033 (usage endpoint as the quota source) and ADR-0031 §4 for token profiles; neither is
   edited here.
3. **Codex `login` profiles use a named volume.** Auth in `CODEX_HOME` on a named volume works and
   survives container recreation. The volume must hold the only live copy of the refresh token:
   move the profile or run a fresh device login in the volume; never keep a shared copy, because
   whichever copy refreshes first invalidates the other.
4. **Minimal fine-grained PAT permissions**, repository `omi` only:
   - Metadata: Read (mandatory)
   - Contents: Read and write
   - Pull requests: Read and write
   - Issues: Read and write
   - Workflows: Read and write, only if workers may change `.github/workflows` (a push of such
     commits needs it)
   - Organization Projects: Read and write

   Not needed for these checks: Administration, Actions write, Secrets, Environments.

## Open items

- **Codex refresh (unverified).** The spike volume held a copy of the host refresh token and was
  deleted after the spike; do not rerun from it. Seed a new volume with a fresh
  `codex login --device-auth` (the only copy of that refresh token), run `codex exec` after its
  access token expires (about 10 days after login; the copied token's expiry was
  2026-11-20T06:42Z), and confirm `last_refresh` and the token iat advance and the call still
  succeeds. Until then the claim "refreshes on its own" is not made. If it fails, fall back to a
  device login per volume refresh.
- **Claude setup-token expiry.** `claude setup-token` (2.1.322) states on screen "long-lived
  (1-year) auth token", so the token must be rotated yearly. `loginExpiresAt` is null: the CLI does
  not report the expiry, so doctor cannot read it and the issue date must be tracked by other means.

## Consequences

- #319 (settings and credential ADR): `.omi/omisetting.local.json` may hold one `github.token`
  (not per profile) and one Claude setup-token per Claude profile, passed to containers by env
  name; the Codex profile is a volume reference, not a stored secret. The settings ADR must record the PAT permission set above and the
  rule that a Codex volume is never a shared copy.
- #320 (Docker runtime): mount one named volume per profile (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`),
  run as uid 1000 with mode 600 auth files, inject tokens with `-e NAME` only, and have quota
  selection use `rate_limit_event`/probe for token profiles instead of the usage endpoint.
- No production code changes in this Issue.
