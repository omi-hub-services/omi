---
name: omi-watch
description: Launch the framework workflow monitor for the Coordinator without collecting status by hand.
---

# omi-watch (Coordinator only)

Run in a terminal that stays open:

```
.omi/bin/omi watch --project .
```

On Windows use `node .omi/bin/omi.cjs watch --project .` through the installed launcher.
For Docker-configured projects the launcher uses `docker exec -i` and reads worker logs
inside the container. Start it with `node .omi/bin/omi.cjs docker up` first. Projects without
a Docker block keep the existing WSL transport.
Open the loopback URL printed by the CLI. Report that URL or the actual startup error. The
CLI owns snapshots and refresh; do not reconstruct worker or quota data. Stop the terminal
process when monitoring is finished. This is script-first monitoring, with no paid probe or
state mutation. Workers must not load this skill.
