---
name: minimal-change
description: Use for any code change. Make the smallest complete change that fully solves the task, reuse what exists, add nothing nobody asked for, and report what you skipped.
---

# Minimal change

Adapted from Ponytail (`AGENTS.md`, `.openclaw/skills/ponytail/SKILL.md`; MIT, DietrichGebert).
See `../NOTICE.md`.

The best code is the code never written. Solve the whole problem with the least new code, and be
lazy about the solution, never about the change itself.

## Before you write

Read the task and the code it touches. List every place the change must reach: callers, tests,
fixtures, configuration, exports, documents. Check what it could break: data it would destroy or
expose, callers that stop working. That is scope. Extra features are not.

## The smallest complete change

Take the first option that fully works:

1. Does it need to exist? Skip features, options and flexibility nobody asked for, and name them in
   one line. A vague request gets the smallest version that does the core job; if the vagueness
   changes what gets built, report an open question instead of guessing.
2. Is it already in this codebase (a helper, component, service, pattern)? Use it the way the
   surrounding code does.
3. Does the standard library or the platform do it? Use that, unless the project has its own.
4. Is there an installed dependency that does it? Use it. Never add a dependency for a few lines;
   a new dependency needs a recorded reason, an exact pin and a checked licence.
5. Can it be one line a reader gets at a glance? Then one line.
6. Otherwise, the minimum code that works.

## Rules

- Finish every part the task needs, including the callers, tests and fixtures your change breaks.
- No abstraction, wrapper, option, configuration, boilerplate or "for later" code nobody asked for.
  Deletion beats addition. Keep the structure the codebase already has: its layers, interfaces and
  conventions, and its file-placement rules.
- The shortest working diff wins once you know everything it must touch. A one-liner that needs
  decoding is not short.
- Comment only the why that the code cannot show, in one line.
- Bug fix: before you edit, find every caller of the function you touch, then fix the root cause
  once in the shared code.
- Code you move or merge keeps its error handling and validation.
- Between options of equal size, take the one that is correct on edge cases.
- New non-trivial logic (a branch, a loop, a parser, money, security) leaves a small test. Trivial
  changes need none.
- A shortcut with a known limit gets a comment: `shortcut: <the limit>, <when to upgrade>`.

## Never cut

Validation at trust boundaries, error handling that prevents data loss, security, accessibility,
and anything the task or acceptance criteria asked for.

## Report

End your report with one or two lines: what you skipped or did not check, and any risk the reader
must know.
