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
matches; it must be in `ready` (Ready, all blockers closed), otherwise stop and say why. Without
one, take `ready[0]` unless the status gives a reason not to. Unfinished work in flight (an open
PR, a running worker) comes first. Read the Issue (`gh issue view N`) and the docs CLAUDE.md
lists.

## 2. Start

```
node tools/coordinator/flow.ts set-status N "In Progress"
node tools/coordinator/flow.ts start-branch N <slug>        # task/omi-NNN-<slug> in WSL
```

## 3. Dispatch the worker (judge the prompt)

Write the prompt to WSL `~/omi-runs/omi-NNN-prompt.md` (Windows path
`\\wsl.localhost\Ubuntu-24.04\home\<user>\omi-runs\`). Include: Issue number, read-first list,
the branch, what to build, `npm run check` before reporting, **no push/PR/merge**, `gh`
read-only, no env-prefixed commands or pipes (use a script in `.tmp/`), no writes under
`.claude/` (protected; the worker cannot), and the final report format (branch, SHAs, files per
layer, check result, what is unverified, open decisions).

Launch in the background (proven command; `<profile>` is the PO's worker profile). Written for
Git Bash: every `\$` must reach WSL unexpanded (in PowerShell use `$` inside single quotes).

```
wsl.exe -d Ubuntu-24.04 --cd /home/<user>/github/omi --exec bash -lc "source ~/.nvm/nvm.sh >/dev/null; export CLAUDE_CONFIG_DIR=\$HOME/.claude-profiles/<profile>; unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; ts=\$(date +%Y%m%d-%H%M%S); claude -p --output-format stream-json --verbose --max-turns 200 --permission-mode acceptEdits --allowedTools Read Edit Write Grep Glob TodoWrite 'Bash(git *)' 'Bash(npm *)' 'Bash(npx *)' 'Bash(node *)' 'Bash(gh issue view *)' 'Bash(gh issue list *)' 'Bash(gh pr view *)' 'Bash(gh pr list *)' 'Bash(gh api *)' 'Bash(gh project *)' 'Bash(ls *)' 'Bash(cat *)' 'Bash(mkdir *)' 'Bash(ps *)' < ~/omi-runs/omi-NNN-prompt.md > ~/omi-runs/omi-NNN-\$ts.jsonl 2> ~/omi-runs/omi-NNN-\$ts.err; echo exit=\$?"
```

- `--allowedTools` patterns match a command prefix. `VAR=x cmd`, pipes and `&&` chains do not
  match and are silently denied in `-p` mode, hence the prompt rule above. `Bash(git *)` and
  `Bash(gh api *)` would also allow push/mutations; only the prompt forbids them.
- Watch with `/omi-status` (worker process, newest log, `session_id`). The worker's final report
  is the `result` field of the last log line.
- Resume (turn limit, follow-up, fix findings): same command with `--resume <session_id>` and
  the follow-up text as the stdin prompt.

## 4. Verify, push, PR

Take the head SHA from the worker report, then:

```
node tools/coordinator/flow.ts check <branch> --head <sha>     # npm run check on exactly <sha>
node tools/coordinator/flow.ts push <branch>
node tools/coordinator/flow.ts open-pr N <branch> --title "OMI-NNN: …" --body-file <f>
node tools/coordinator/flow.ts set-status N "In Review"
```

**(judge)** The PR body has `Issue: #N`, changes, a file → layer table, check evidence,
dependency/ADR notes, approval needs.

## 5. Independent review (judge)

Start a fresh review subagent (not the worker, not you) pinned to `<sha>`: diff, AC, rules in
AGENTS.md, evidence. Post its verdict with `gh pr comment <pr> --body-file <f>`; the body must
contain `**VERDICT:** PASS|FAIL · **REVIEWED_HEAD:** \`<sha>\`` (status.ts reads it). FAIL →
resume the worker with the findings, then repeat 4–5 for the new SHA (limit 2 + Architect + 2,
design-patterns.md; then ask the PO).

## 6. Merge, close, clean up

When `/omi-status` shows checks `pass` and `agent PASS @head`:

```
node tools/coordinator/flow.ts merge <pr> --head <sha>
node tools/coordinator/flow.ts close N --comment-file <f>     # comment + close + Done
node tools/coordinator/flow.ts cleanup <branch>
```

**(judge)** The closing comment states the PR, merge commit, checks and review verdict. Report
the outcome to the PO in a few lines.
