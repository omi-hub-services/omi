---
name: test-driven-development
description: Use when implementing a feature, bugfix, refactor or behaviour change, before writing implementation code. Write a failing test, watch it fail, write minimal code to pass.
---

# Test-driven development

Adapted from Superpowers `test-driven-development` (MIT, Jesse Vincent). See `../NOTICE.md`.

Write the test first. Watch it fail. Write minimal code to pass. If you did not watch the test fail,
you do not know that it tests the right thing.

## When

Always for new behaviour, bug fixes, refactors and behaviour changes. Exceptions are throwaway
spikes, generated code and pure configuration, and only where the task or the project rules say so.
When unsure whether an exception applies, say so in your report instead of deciding silently.

## The rule

```
No production code without a failing test first.
```

If you wrote code before the test, discard it and start again from the test. Do not keep it as
"reference". Delete only your own uncommitted work in your own workspace; never discard anyone
else's changes.

## Red, green, refactor

1. **Red.** Write one minimal test for one behaviour, with a name that states the behaviour. Use
   real code; mock only what you cannot avoid. A test that asserts on a mock proves nothing.
2. **Verify red (mandatory).** Run the test. Confirm that it fails (not errors), that the message is
   the one you expected, and that it fails because the behaviour is missing, not because of a typo.
   If it passes, you are testing existing behaviour: fix the test.
3. **Green.** Write the simplest code that passes. No extra options, no "improvements" beyond the
   test.
4. **Verify green (mandatory).** Run the test, then the project's whole test suite, not only your
   file. A green run of your own test is not a green suite. Report every failure by name, including
   ones you did not cause.
5. **Refactor** only when green: remove duplication, improve names. Do not add behaviour.

## Bugs

Reproduce the bug with a failing test first, then fix it. The test proves the fix and guards
against regression. For a regression test, check that it fails with the fix reverted.

## Good tests

| Quality | Good                                                | Bad                                                    |
| ------- | --------------------------------------------------- | ------------------------------------------------------ |
| Minimal | One behaviour. An "and" in the name means split it. | `validates email and domain and whitespace`            |
| Clear   | The name describes the behaviour.                   | `test1`                                                |
| Honest  | Fails when the behaviour breaks.                    | Restates the implementation, or only exercises a mock. |

Before writing a test, name the production change that would make it fail. Keep test-only code in
tests, out of production classes. Understand a dependency's side effects before mocking it.

## Rationalisations

| Excuse                                 | Reality                                                 |
| -------------------------------------- | ------------------------------------------------------- |
| "Too simple to test"                   | Simple code breaks. The test takes seconds.             |
| "I'll add tests after"                 | Tests written after pass immediately and prove nothing. |
| "I tested it manually"                 | Manual checks leave no record and cannot be re-run.     |
| "A hard test means the design is fine" | A hard test usually means the design is too coupled.    |

## Before reporting the work complete

- [ ] Every new behaviour has a test, and you watched each fail for the expected reason.
- [ ] You wrote only the code needed to pass.
- [ ] The whole suite passes with no new warnings, or each failure is named in your report.
- [ ] Edge cases and error paths are covered.

Cannot tick every box: say which one and why, in your report.
