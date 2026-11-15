---
name: omi-status
description: Read framework delivery status and recommend one next action in the Coordinator session.
---

# omi-status (Coordinator only)

Run the installed framework CLI from the project root:

```
.omi/bin/omi status --project .
```

On Windows use `node .omi/bin/omi.cjs` with the same arguments; the installed launcher
selects `docker exec -i` when local settings contain a `docker` block and otherwise keeps
the WSL binding. Docker status and logs are read inside the project container. Use `--json`
when a field is needed; never put token values on the command line.

Data collection is script-first. Report counts, work in flight, PR checks, review state,
attention, workers and quota as the CLI reports them. Unknown stays unknown. Recommend one
next action, finishing work in flight before selecting a ready task. Do not change state.
If the command fails, report its error; do not rebuild the answer with raw GitHub or Git calls.
Use omi-next for execution and omi-watch for monitoring. Workers must not load this skill.
