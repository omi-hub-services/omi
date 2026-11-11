---
name: omi-status
description: Show the omi-squad delivery status (Project items by Status, unblocked Ready tasks, open PRs with checks/review, WSL workers, worker quota) and recommend the next task. Use at the start of a Coordinator session or when asked "what's the status / what's next".
---

# /omi-status

Data collection is a script; do not re-derive it with `gh`/`git` calls (AGENTS.md §9).

1. From the repository root run:

   ```
   node tools/coordinator/status.ts
   ```

   Use `--json` only if you need a field the text omits. If the script fails (e.g. `gh` not
   logged in), report the error line and stop; do not fall back to manual queries.

2. Reply in at most ~10 lines:
   - counts per Status, and what is In Progress / In Review / Blocked / Waiting;
   - open PRs: checks state, whether the agent review is `PASS @head`, missing `Issue:` link;
   - "Attention" lines (Status and Issue state disagree) and running or finished workers
     (a finished log with an error, or a stale log with no worker process, needs action);
   - quota: one short line per profile from the "Quota" section (5h/7d left, data age);
     say when no profile is above the thresholds and when the next reset is. This read has
     no probe, so Claude numbers may be old or `unknown`; `/omi-next` probes before dispatch;
   - **Recommendation:** one next action with a one-line reason. Priority: finish work already
     in flight (merge a green, reviewed PR; resume a stopped worker) before starting a new task;
     otherwise the first entry under "Ready, all blockers closed", or when that is empty the
     first under "Backlog, all blockers closed" (`/omi-next` promotes it), unless something in
     the status argues against it (say what, e.g. no worker quota until a reset).

3. Do not change anything. Starting the task is `/omi-next [OMI-xxx]`.
