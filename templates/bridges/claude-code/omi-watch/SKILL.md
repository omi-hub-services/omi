---
name: omi-watch
description: Launch the framework workflow monitor for the Coordinator without collecting status by hand.
---

# omi-watch (Coordinator only)

Run in a terminal that stays open:

```
.omi-squad/bin/omi watch --project .
```

On Windows use `node .omi-squad/bin/omi.cjs watch --project .` through the installed launcher.
Open the loopback URL printed by the CLI. Report that URL or the actual startup error. The
CLI owns snapshots and refresh; do not reconstruct worker or quota data. Stop the terminal
process when monitoring is finished. This is script-first monitoring, with no paid probe or
state mutation. Workers must not load this skill.
