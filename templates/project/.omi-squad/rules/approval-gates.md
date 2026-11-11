---
id: approval-gates
version: 1
mandatory: true
---

# Approval gates

- An approval is an explicit decision recorded by the runtime, never inferred from text.
- Do not buy services, change business behaviour, release or deploy to production without a
  recorded approval for that action.
- The author of a change never approves or merges their own change; review is a separate run on a
  fixed revision.
- A rule or workflow change must not relax an approval requirement.
