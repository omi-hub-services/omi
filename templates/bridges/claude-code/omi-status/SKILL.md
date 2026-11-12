---
name: omi-status
description: Read framework delivery status and recommend one next action in the Coordinator session.
---

# omi-status (Coordinator only)

Run the installed framework CLI from the project root:

```
.omi-squad/bin/omi status --project .
```

On Windows use `node .omi-squad/bin/omi.cjs` with the same arguments; the installed launcher
binds the WSL distribution and project. Use `--json` when a field is needed.

Data collection is script-first. Report counts, work in flight, PR checks, review state,
attention, workers and quota as the CLI reports them. Unknown stays unknown. Recommend one
next action, finishing work in flight before selecting a ready task. Do not change state.
If the command fails, report its error; do not rebuild the answer with raw GitHub or Git calls.
Use omi-next for execution and omi-watch for monitoring. Workers must not load this skill.
