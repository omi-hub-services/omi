---
id: script-first
version: 1
mandatory: false
---

# Script first, LLM second

- Deterministic work is done by a script, a CLI or the runtime, never by LLM reasoning: reading
  GitHub or Project state, mechanical git and `gh` steps, parsing logs and reports, changing a
  status, checking a gate, building a launch command or a comment from a fixed format.
- Use the LLM only where judgement is needed: choosing work, writing a prompt or a spec,
  reviewing, and deciding what to do when a step fails or is refused.
- A script that refuses a step is a gate, not an obstacle. Fix the cause or ask the Coordinator;
  never work around it with raw commands.
- If a step has to be repeated by hand, add it to a script instead of repeating it.
- Do not paste large logs or state into the conversation to read them: run the script that
  extracts the part you need.
