---
name: omi-next
description: Run the next omi-squad task end to end as the Coordinator (pick an unblocked Ready task or the named one, start a branch, dispatch a Claude Code worker in WSL, verify, PR, independent review, merge, close, clean up). Use when asked to do the next task or a specific OMI-xxx task.
argument-hint: "[OMI-xxx]"
---

# /omi-next [OMI-xxx]

The process proven in OMI-002 (ADR-0012, ADR-0014). Mechanical steps are
`node tools/coordinator/flow.ts …` (idempotent; add `--dry-run` to preview). `done:` means the
step already happened; `refused:` is a gate — fix the cause or ask the PO, never bypass it with
raw `gh`/`git`. Your judgement is needed only where marked **(judge)**.

**Stop and ask the PO** for: unclear scope/AC, a new dependency or an ADR-level choice the Issue
does not cover, profile/quota/cost (more turns, extra live runs), anything into `main`, or a gate
you cannot fix.

## 1. Pick (judge)

`node tools/coordinator/status.ts --json`. With an argument, take the item whose `planKey`
matches; if it is in Backlog, run `node tools/coordinator/flow.ts promote N` first (OMI-060:
Backlog → Ready only when every blocker is closed and the readiness gate passes). It must then be
in `ready`; on `refused:` stop and say why. Without one, take `ready[0]`; if `ready` is empty, run
`flow.ts promote` (no N: first entry under "Backlog, all blockers closed") and take that Issue.
Unfinished work in flight (an open PR, a running worker) comes first. At most 3 tasks run in
parallel (PO). A task that waits on the PO gets a Coordinator comment
`**WAITING-PO:** <reason>` and a task waiting on an open blocker goes back to Backlog, so
`/omi-watch` shows Waiting PO / Blocked instead of a stale step (OMI-086, ADR-0014). Read the Issue (`gh issue view N`) and the docs CLAUDE.md
lists.

**New Issues** are created only with `node tools/coordinator/flow.ts new-issue --file <spec.md>`
(`--dry-run` first; spec format in ADR-0014). Never `gh issue create` by hand: `set-status`
Ready/In Progress and `start-branch` refuse an Issue that fails the readiness gate (Plan Key
matching the marker, Priority/Work Type/Workflow/Role/Area, at least one top-level AC), and
`status.ts` lists such Issues under Attention.

## 2. Start

```
node tools/coordinator/flow.ts set-status N "In Progress"
node tools/coordinator/flow.ts start-branch N <slug>        # task/omi-NNN-<slug> in WSL
```

**Parallel tasks:** one checkout per running worker. For a second task, create a WSL worktree
(`git worktree add --detach ~/github/omi-wt/omi-NNN origin/develop`, then `npm ci` there) and
run every `flow.ts` step of that task with `OMI_WSL_REPO_DIR=/home/<user>/github/omi-wt/omi-NNN`
(plus `MSYS_NO_PATHCONV=1` in Git Bash); dispatch with `--cd` to the worktree and tell the
worker to stay in it. `cleanup` with the same `OMI_WSL_REPO_DIR` removes a clean worktree,
fast-forwards develop in the main checkout and deletes the merged branch (OMI-062).

## 3. Dispatch the worker (judge the prompt)

Write the prompt to WSL `~/omi-runs/omi-NNN-prompt.md` (Windows path
`\\wsl.localhost\Ubuntu-24.04\home\<user>\omi-runs\`). Include: Issue number, read-first list,
the branch, what to build, `npm run check` before reporting, **no push/PR/merge**, `gh`
read-only, no env-prefixed commands or pipes (use a script in `.tmp/` run with `node`), no
writes under `.claude/` (protected; the worker cannot), and the final report format (branch,
SHAs, files per layer, check result, **Skills applied** with evidence per skill, what is
unverified, open decisions).

**Curated skills inline (OMI-073).** Workers get the role's curated skills as prompt text, never
as native skills: native listing is no guarantee (the OMI-039 worker had 50 skills listed and made
0 `Skill` calls) and would expose the Coordinator skills. Developer workers (Claude and Codex)
get `test-driven-development`, `minimal-change` and `verification-before-completion`; append them
after writing the prompt, from the worker's checkout:

```
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 --cd <repo> --exec bash -lc "for s in test-driven-development minimal-change verification-before-completion; do printf '\n\n## Skill: %s (follow it; report it under Skills applied)\n\n' \$s; cat templates/project/.omi-squad/skills/\$s/SKILL.md; done >> ~/omi-runs/omi-NNN-prompt.md"
```

The review subagent's prompt gets `independent-review` the same way (read the file and paste
it in). Claude workers launch with `--disable-slash-commands` (no native skills at all, CLI
2.1.322 probe); Codex workers have no `--disable` flag, so `$CODEX_HOME/skills` of a worker
profile stays empty. Plugins and their hooks still load for Claude workers; removing them is
OMI-072 (product runtime).

Pick the worker profile by quota (script, OMI-053) right before launching:

```
node tools/coordinator/flow.ts pick-profile N [--kind codex|claude+codex-live] --probe
```

- `--kind` defaults to `claude`; use `claude+codex-live` when the worker's live tests call
  Codex (needs a Claude writer and a Codex profile both above threshold), `codex` for a Codex
  worker. `--probe` spends one minimal Haiku call per Claude profile for fresh numbers; Codex
  limits are read free through `codex app-server`.
- Output `pick-profile N: claude <profile>` (and `codex <profile>`) names the profile(s) to
  use; the `reason:` and `ranked:` lines explain the choice.
- It also prints `<tool> model: <m> effort: <e> (complexity <c>: <reason>)` for each chosen
  tool and `reviewer: <m> <e>` (OMI-058, ADR-0014). Pass exactly these to the worker
  (`--model`/`--effort`, Codex `-m`/`-c model_reasoning_effort=`) and to the review subagent;
  do not re-derive them. A `complexity:low|medium|high` label on the Issue overrides the rule.
- `refused:` (exit 1, every profile below the thresholds in `coordinator-settings.ts`) →
  **stop and ask the PO**: wait until the printed earliest reset, or spend a Codex reset
  credit (the count is printed). Spending a credit is the PO's decision, never yours.

**Scripted dispatch (OMI-077, preferred).** Write the prompt to a local file, then let the script
copy it to WSL, append the curated skills and run the exact command below (run it with the Bash
tool's `run_in_background`; `--dry-run` prints it; add `OMI_WSL_REPO_DIR` for a worktree):

```
node tools/coordinator/flow.ts dispatch N --profile <p> --kind claude|codex --prompt <file> [--resume <session|thread id>] [--dry-run]
node tools/coordinator/flow.ts worker-report N        # final report, turns, denials, resume id
node tools/coordinator/flow.ts commit-worker <branch> --message-file <local file>   # Codex output
```

Workers never run on the Coordinator profile (`ggtintran`), even when `pick-profile` ranks it
first. The manual form follows for reference.

Launch in the background with the chosen Claude profile as `<profile>`; it is also part of
the log name, which is how `status.ts` attributes Claude quota to a profile. For
`claude+codex-live` add `export CODEX_HOME=\$HOME/.codex-profiles/<codex-profile>;` after
`CLAUDE_CONFIG_DIR`. Written for Git Bash: every `\$` must reach WSL unexpanded (in
PowerShell use `$` inside single quotes), and `MSYS_NO_PATHCONV=1` stops Git Bash from turning
the `--cd /home/...` path into a Windows path (`Wsl/ERROR_PATH_NOT_FOUND`); PowerShell needs no
prefix.

```
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 --cd /home/<user>/github/omi --exec bash -lc "source ~/.nvm/nvm.sh >/dev/null; export CLAUDE_CONFIG_DIR=\$HOME/.claude-profiles/<profile>; unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; ts=\$(date +%Y%m%d-%H%M%S); claude -p --disable-slash-commands --output-format stream-json --verbose --max-turns 200 --permission-mode acceptEdits --allowedTools Read Edit Write Grep Glob TodoWrite 'Bash(git status*)' 'Bash(git diff*)' 'Bash(git log*)' 'Bash(git show*)' 'Bash(git add *)' 'Bash(git commit *)' 'Bash(git switch *)' 'Bash(git fetch*)' 'Bash(git rev-parse *)' 'Bash(git restore *)' 'Bash(git ls-files*)' 'Bash(git grep *)' 'Bash(npm run *)' 'Bash(npm ci)' 'Bash(node *)' 'Bash(gh issue view *)' 'Bash(gh issue list *)' 'Bash(gh pr view *)' 'Bash(gh pr list *)' 'Bash(gh pr diff *)' 'Bash(gh project item-list *)' 'Bash(gh project field-list *)' 'Bash(gh project view *)' 'Bash(ls *)' 'Bash(cat *)' 'Bash(mkdir *)' 'Bash(ps *)' --disallowedTools 'Bash(git push*)' 'Bash(git reset --hard*)' 'Bash(gh api*)' 'Bash(npm install*)' 'Bash(git commit --no-verify*)' 'Bash(git commit -n*)' 'Bash(git commit --amend*)' 'Bash(git switch --discard-changes*)' 'Bash(git switch -C*)' 'Bash(git switch -f*)' 'Bash(git switch --force*)' < ~/omi-runs/omi-NNN-prompt.md > ~/omi-runs/omi-NNN-<profile>-\$ts.jsonl 2> ~/omi-runs/omi-NNN-<profile>-\$ts.err; echo exit=\$?"
```

- This allowlist is the default for every task: specific git subcommands, `npm run`/`npm ci`,
  read-only `gh`, `node`, `ls`, `cat`, `mkdir`, `ps`. `--disallowedTools` wins over
  `--allowedTools`, so push, hard reset, `gh api`, `npm install`, `git commit --no-verify` /
  `-n` / `--amend` and `git switch --discard-changes` / `-C` / `-f` / `--force` stay denied even if a pattern
  above would match (flag-first forms only; a flag after other arguments is a known gap,
  ADR-0014). Denials appear as `permission_denials` in the final `result`
  event of the log.
- **Extra permissions for one task** (e.g. a `gh api` GET, `npm install` of a dependency the
  Issue approves) are added to that task's dispatch command only, named in that task's prompt
  and listed in its PR body with the reason. Never add them to this default.
- Residual risk (ADR-0014): `node` and `npm run` can still run arbitrary code with the PO's WSL
  `gh`/git login; the allowlist prevents mistakes, not a hostile worker.
- `--allowedTools` patterns match a command prefix. `VAR=x cmd`, pipes and `&&` chains do not
  match and are silently denied in `-p` mode, hence the prompt rule above.
- Watch with `/omi-status` (worker tool, pid, mode, elapsed time; newest log and `session_id`).
  The worker's final report is the `result` field of the last log line.
- Resume (turn limit, follow-up, fix findings): same command, `MSYS_NO_PATHCONV=1` prefix
  included, with `--resume <session_id>` and the follow-up text as the stdin prompt.

## 4. Verify, push, PR

Take the head SHA from the worker report, then:

```
node tools/coordinator/flow.ts check <branch> --head <sha>     # npm run check on exactly <sha>
node tools/coordinator/flow.ts push <branch>
node tools/coordinator/flow.ts open-pr N <branch> --title "OMI-NNN: …" --body-file <f>
node tools/coordinator/flow.ts set-status N "In Review"
```

**(judge)** The PR body has `Issue: #N`, changes, a file → layer table, check evidence,
dependency/ADR notes, approval needs, and any extra worker permissions used for this task.

## 5. Independent review (judge)

Start a fresh review subagent (not the worker, not you) pinned to `<sha>`: diff, AC, rules in
AGENTS.md, evidence, and the worker's "Skills applied" claims against the diff (e.g. tests
before or with the implementation, check output quoted; a claim without evidence is a
finding, not a FAIL by itself). Post its verdict with
`node tools/coordinator/flow.ts review-comment <pr> --file <f>` (validates VERDICT, REVIEWED_HEAD =
PR head and one AC line per criterion before posting; OMI-077) from the Coordinator account (`COORDINATOR_LOGIN` in `coordinator-settings.ts`); `VERDICT` comments by
any other account are ignored by `merge`, `close` and `status.ts` (which flags them). The body
must contain:

- ``**VERDICT:** PASS|FAIL · **REVIEWED_HEAD:** `<sha>` `` (status.ts and `merge` read it);
- one line per acceptance criterion, at the start of the line, numbered by the order of the
  criteria under the Issue's `## Acceptance criteria` heading (`close` reads them). Count only
  **top-level** checkboxes (list marker in column 0) directly under that heading; skip nested
  checkboxes, checkboxes inside a code fence and everything below a `###` sub-heading of the
  section (`acceptance-criteria.ts` counts the same way):

  ```
  AC-1: met — <evidence>
  AC-2: not met — <what is missing>
  ```

  Every criterion gets exactly one line; PASS requires every line to be `met`.

FAIL → resume the worker with the findings, then repeat 4–5 for the new SHA (limit: 2 rounds,
then Architect, then 2 more; design-patterns.md; then ask the PO). When you call the Architect,
first post `gh pr comment <pr> --body "**ARCHITECT:** <reason>"` from the Coordinator account
(reason required; ADR-0014, OMI-074): `/omi-watch` lights the Architect node from it and warns
at two FAILs without it.

**Parallel tasks, one review each (OMI-069, ADR-0014).** Before step 4, merge `origin/develop`
into a finished branch so the review sees the current base. A PR that goes `BEHIND` _after_ its
PASS (another task merged first) is synced with a script, not re-reviewed:

```
node tools/coordinator/flow.ts sync <branch> --reviewed <sha> --dry-run
node tools/coordinator/flow.ts sync <branch> --reviewed <sha>   # merge develop, check, push, carried PASS
```

Then merge with `--head` set to the new head. `merge`/`close` accept the carried PASS only for a
clean merge commit. `refused:` with conflicted files → resolve the conflict, then a fresh
subagent reviews only the conflict resolution (diff between the automatic merge tree and the
head), not the whole task.

## 6. Merge, close, clean up

```
node tools/coordinator/flow.ts merge <pr> --head <sha>
node tools/coordinator/flow.ts close N --comment-file <f>     # tick AC + comment + close + Done
node tools/coordinator/flow.ts cleanup <branch>
```

- `merge` refuses unless required checks are green, the newest agent review (Coordinator
  account) is `PASS` on exactly `<sha>`, and the merge state is `CLEAN` or `HAS_HOOKS`.
- `close` finds the PR of this repository merged last (`mergedAt`) into develop with
  `Issue: #N`, requires the newest agent review (Coordinator account) on it to be `PASS` on its
  merged head, and ticks the Issue's Acceptance criteria checkboxes
  from the `AC-<n>` lines (only that section of the body changes). It refuses, and closes
  nothing, when a criterion has no line or is `not met`; fix that with a new review comment,
  not by editing the Issue by hand.
- `cleanup --dry-run` only reads (no fetch); the real run fetches first.
- `cleanup` also archives the task's worker logs in `~/omi-runs` (OMI-056): moved to
  `archive/` and gzipped, empty `.err` and `omi-NNN-current` deleted, the newest `.jsonl` of each
  profile and files of a running worker kept, `archive/` capped by `RUNS_RETENTION`. For a
  worktree task it refuses while the worktree has uncommitted files (OMI-062).
  `flow.ts prune-runs [--dry-run]` sweeps all Done tasks once.

**(judge)** The closing comment states the PR, merge commit, checks and review verdict. Report
the outcome to the PO in a few lines.
