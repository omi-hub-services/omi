# Design — `.omi` install dir, `omisetting.local.json`, Docker workers

- Date: 2026-11-15
- Status: Approved by PO in chat (2026-11-15); pending spec review
- Supersedes on completion: ADR-0012 (Coordinator on Windows, runtime in WSL2), ADR-0028 (WSL2
  lifecycle PoC); amends ADR-0022 (credential boundary) and ADR-0031 (profile = directory)

## Goal

A PO creates a new local project from a GitHub repo, installs the framework, fills one settings
file and starts working. No WSL distro, nvm, shell aliases or manual `claude`/`gh` logins
(except a one-time Codex device login). Workers run in Docker; the Coordinator stays the Claude
Code session on Windows.

## Decisions

### 1. Install directory `.omi`

- The directory installed into a project is renamed `.omi-squad/` → `.omi/`. The package and
  executable name `omi-squad` is unchanged.
- All references are rewritten by one deterministic script, then `npm run check`. Accepted ADRs
  keep their text; a status note records the rename.
- `omi install` / `omi update` that find `.omi-squad/` stop with a message pointing to
  `omi migrate-dir`, which runs `git mv .omi-squad .omi` and rewrites the lockfiles. No
  dual-name reading.

### 2. `.omi/omisetting.local.json`

Gitignored, plaintext, the only place secrets live. Installer adds it to `.gitignore` and writes a
committed `.omi/omisetting.example.json` with fake values.

```json
{
  "$schema": "./tool/schemas/omisetting.schema.json",
  "version": 1,
  "github": {
    "token": "github_pat_xxx",
    "gitUser": { "name": "omi-bot", "email": "omi-bot@example.com" }
  },
  "profiles": [
    { "id": "claude-main", "tool": "claude", "auth": { "type": "token", "token": "sk-ant-oat01-xxx" } },
    { "id": "codex-main", "tool": "codex", "auth": { "type": "login" } }
  ],
  "docker": { "container": "omi-<repo>", "image": "omi-worker:<framework-version>", "memory": "8g" }
}
```

Clarity rules (PO requirement: the file must be clear):

- Only `github.token` and `profiles[].auth.token` are secrets. Every other field is plain config.
- The JSON Schema describes every field, including how to obtain it (`claude setup-token`;
  fine-grained PAT with Contents, Pull requests, Issues, Projects). VS Code shows it on hover.
- `docker` is optional; defaults derive from the repo name and framework version.
- `github.token` must belong to an account other than the PO's, because `main` needs an approval
  from someone other than the PR author.
- `auth.type: "login"` (Codex: ChatGPT plans have no static token): `omi profile login <id>` runs
  a device login once into Docker volume `omi-profile-<id>`; the CLI refreshes it there.
- `doctor` validates the schema, checks tokens live (`gh api user`, `claude auth status`), checks
  the file is not tracked by git, and reports errors by field path
  (`profiles[1].auth.token: expired`).

A new ADR replaces the "framework holds no secret" boundary: secrets are read only from this file,
passed only as process env of the one worker that needs them, and never written to prompts,
packets, logs, artifacts or state. The credential guard gains the known token values as
`CredentialPolicy` secrets. The Claude adapter's `FORBIDDEN_AUTH_ENV` becomes "only the selected
profile's token".

### 3. Docker runtime

- **Image:** `templates/docker/Dockerfile`, built locally by `omi docker build`, tag
  `omi-worker:<framework-version>`. Node 24 bookworm-slim, git, gh, make/g++/python3 (native
  modules build, so `npm ci` works), pinned Claude CLI and Codex CLI, non-root user `omi`.
  No registry publishing.
- **Container:** one long-lived container per project, `omi-<repo>`, `--restart unless-stopped`,
  `--memory` from settings (default 8g) so a runaway worker cannot exhaust the host.
- **Volumes:** `omi-<repo>-work` at `/work` (repo clone, worktrees, `.omi/local`, per-profile
  session dirs); `omi-profile-<id>` at `/profiles/<id>` for `login` profiles only. No bind mount
  from NTFS.
- **First start:** clones the repo with `github.token`, sets git user from `gitUser`.
- **Secrets in:** never container env (visible in `docker inspect`). The Coordinator reads the
  settings and passes per call `docker exec -e GH_TOKEN -e CLAUDE_CODE_OAUTH_TOKEN …` (names only;
  values from the calling process env, never argv).
- **Coordinator calls:** `wslTarget` (`tools/coordinator/coordinator-target.ts`) is replaced by
  `dockerTarget`: `docker exec -i -w /work/<repo> omi-<repo> bash -lc …`; scripts and prompts via
  stdin as today. `docker exec -i` keeps a pipe, so ADR-0028's EOF liveness model is unchanged.
- **Doctor:** WSL kernel/distro/interop checks are replaced by `docker version`, container
  running, volumes present, CLI versions in the container, settings checks.
- **Watch/status:** read worker logs via `docker exec` instead of WSL paths.
- **Dropped for now:** Windows Edge screenshots from workers. Add Chromium to the image when a
  task needs it.

### 4. Docker cleanup (PO requirement: no Docker garbage growth)

Cleanup is part of closing a task and is scripted (`flow.ts cleanup`), not left to the LLM:

- **After each task:** kill any process left in the container from that task's worker
  (process group of the `docker exec`); remove the task worktree and its `node_modules`; remove
  the task's tmp dir; compress the worker log (ADR-0035) and delete the run's scratch files.
- **No per-task containers or images** are created, so nothing else accumulates per task.
- **After `omi docker build`:** remove older `omi-worker:*` images and `docker builder prune`
  the build cache for that image.
- **`omi docker down`:** stops and removes the container; volumes are kept unless `--volumes`.
- **Doctor reports** the work volume size and container memory use, and warns over a threshold.

Acceptance: running five tasks in a row leaves no extra worktrees, processes, images or tmp dirs
in the container compared with before the first task.

### 5. WSL removal

Until Docker passes acceptance on omi-minibox, this repo keeps using WSL. After acceptance this
repo moves to Docker too and all WSL code (`wsl-workers.ts`, WSL parts of `windows-session-launcher.ts`,
`installation-doctor.ts`, `OMI_WSL_*` settings) is deleted. No `runtime: wsl | docker` switch.

## Delivery order

One Issue and PR each, after v0.1.1 (#314) merges:

1. Rename `.omi` + `omi migrate-dir`.
2. Spike: `CLAUDE_CODE_OAUTH_TOKEN` runs `claude -p` on subscription and reads quota
   (`/api/oauth/usage`); Codex device login in a volume refreshes on its own.
3. Credential ADR + `omisetting.local.json` schema, loader, example, guard and env allowlist.
4. Docker runtime: Dockerfile, `omi docker build/up/down`, `dockerTarget`, doctor, cleanup,
   watch/status logs.
5. End-to-end acceptance on omi-minibox: clone, install, fill settings, `doctor`, run tasks,
   cleanup acceptance check.
6. Move this repo to Docker, delete WSL code, supersede ADR-0012 and ADR-0028.

## Risks

- Item 2 may show the setup-token cannot read quota; then quota for token profiles comes only from
  `rate_limit_event` (ADR-0031 §4) until a fallback is chosen.
- Docker Desktop on Windows still uses a WSL2 backend internally; the PO manages no distro, but
  Docker Desktop must be installed and running.
