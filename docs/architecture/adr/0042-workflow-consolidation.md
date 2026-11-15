# ADR-0042: Workflow consolidation

Status: Accepted · 2026-11-15

## Context

PO decision 2026-11-15, Issue #336 (OMI-166). Five tasks produced seven QA/review
pairs. QA judged script evidence without executing suites; both defects found in
OMI-159 were found by review after QA passed. Risk-based packet splitting made
the two workers the usual path, duplicating context and judgement.

This amends ADR-0014's Coordinator quality policy and architecture §9. Historical
OMI-093 grouping policy is superseded for new plans; approval requirements remain.

## Decisions

1. Merge QA into independent review for feature, refactor, bugfix and
   onboarding-empty-repo. Remove verify from those templates; review inherits
   verification-before-completion, evidence-and-tests, project-check and the
   regression/test-preservation gates. Scripts require a green check on the exact
   reviewed SHA and one evidence-bearing AC-n verdict per top-level AC before
   PASS. Bugfix regression evidence records the same command failing on the base
   and passing on the head. The reviewer judges correctness rather than repeating
   mechanical proof. Keep specialist QA in ui-ux, onboarding-takeover and ci-cd.
2. Merge bugfix reproduce/implement into a fix step with systematic debugging and
   TDD. Decided here; implementation belongs to the sibling Issues #337–#340.
3. Hand off ready steps automatically and reuse script checks only by exact SHA.
   A changed head invalidates reuse. Decided here; sibling implementation.
4. Merge small steps where there is no distinct expert handoff or approval
   boundary. Never remove a required approval. Decided here; sibling implementation.
5. Use one cost gate per run, tied to the approved cost scope; a cost change still
   requires approval. Decided here; sibling implementation.
6. Risks add review focus, including security, instead of splitting QA/review
   workers. The dedicated security review skill belongs to the sibling Issues.

OMI-166 implements decision 1 and removes policy-driven grouping/splitting.
Decisions 2–5 and the security skill are recorded decisions, not implemented here.

## Execution and compatibility

Review round 1 uses medium effort; later rounds use low with previous verdict
and bounded delta. Fresh independent review, exact head/base delivery gates,
carried PASS, 2 + Architect + 2 and all business/cost/release approvals remain.
There is no combineVerifyReview policy switch. Templates define worker ownership;
old content-addressed templates and persisted execution graphs retain their steps
and packets through the OMI-133 archive. omi update installs the new templates
without rewriting active runs. No dependency, module directory or schema migration
is introduced.

Regression script output is a strict JSON object with base and head executions:
each contains revision (full SHA), command (nonempty argv), and exitCode. Both
commands must match; the base must exit positively and the head zero. Null exit
status, stale revisions and prose-only evidence fail closed. Runtime validates the
hashed regression-test artifact; repository review-comment reads --regression-evidence.
These artifacts are evidence, never approval. The existing check runner owns actual
project-check execution; the worker's check claim cannot satisfy it.

## Consequences

One review context per coding quality round reduces duplicated reading. Tests
cover template ownership, specialist retention, evidence refusal and old-hash
resolution. Repository and runtime bridges describe the same policy. Protected
native skill installation remains Coordinator-owned.
