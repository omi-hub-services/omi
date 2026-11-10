# ADR-0017 — Domain policies and explicit state machines

- Status: Proposed (the PO still decides the open points below and in the PR)
- Date: 2026-11-10
- Issue: #10 (OMI-008), epic #8, milestone M1 — Core foundation
- Context documents: `docs/architecture/architecture.md` §3.1, §8, §9, §11;
  `docs/engineering/design-patterns.md` §3, §4, §5, §10, §11; `docs/product/product-overview.md`
  §9–§11; ADR-0015 (GitHub capability matrix); ADR-0016 (contract schema v1)

## Decision

1. **State machines are plain rule tables** (`src/domain/shared/transition.ts`): each rule is
   source state, event, target state and an optional precondition that returns a reason code. A
   (state, event) pair without a rule is refused with `TRANSITION_NOT_ALLOWED`. Events are tagged
   objects that carry every fact a precondition reads, time included. No state-machine library.
   Policies that are not state machines return `Decision<Reason>` (`shared/decision.ts`): the
   first refusal is `reason`, all refusals are in `reasons`.
2. **Time and randomness are values.** Domain functions take `now` (epoch ms), a probe TTL or a
   jitter in `[0, 1)`; none reads a clock, `Math.random` or an id generator.
3. **Task `blocked` is split in two**: `blocked_by_dependency` (clears when no predecessor is
   blocked) and `blocked` (quality budget spent, reopened only by a recorded PO decision).
   architecture.md §8 names one `blocked`; the split stops a dependency recovery from reopening a
   task that the PO must decide on. The Project field maps both to "Blocked".
4. **Rework (2 + Architect + 2) is a counter-carrying controller** (`runs/rework-policy.ts`)
   over `{ phase, failedCycles, architectInterventionId, countedCycleIds }`. It holds no
   profile or model, so switching them cannot reset it. Infrastructure failures and waiting for a
   PO decision are refused without counting; a repeated report of the same `cycleId` counts once;
   an Architect solution that changes business scope or cost needs a valid approval first; a PO
   reopen starts a new count and keeps the decision ids. Operational retry
   (`runs/retry-policy.ts`) has its own bounded budget and backoff.
5. **Approval is bound to a subject, not a flag** (`approvals/`): business = baseline hash +
   scope ids; release = PR + head SHA; deploy = artifact digest + environment. ADR-0015 showed a
   GitHub approval survives a push unless the ruleset dismisses it, so the domain re-checks the
   head SHA and `evaluateMerge` refuses an approval made for an older head. A release approval
   never satisfies a deploy approval. A conversational approval needs an evidence reference.
   The approval source is a closed set; worker output is not a source.
6. **Merge** (`delivery/`): `evaluateMerge` requires the review to be for the current head **and**
   base, a review run different from the authoring runs, required checks reported for the
   current head SHA and matched by name, no unresolved mandatory findings, passed workflow gates,
   valid approvals and the merge lock. `merge-state.ts` has a `merge_unknown` state whose only
   exits are remote read-backs, so a timeout after a possibly successful merge never leads to a
   second merge call.
7. **Capability**: the domain keeps its own ordered `EFFORT_LEVELS` (domain must not import the
   contract). A unit test pins it to the contract list. `selectExecutor` applies hard
   requirements (probe-fresh ready profile, account group not in cooldown, model verified for the
   capability profile, supported effort at or above the minimum, concurrency) before preference.
   No candidate gives `WAITING_RESOURCE` with the reasons per candidate.

## Not covered yet

- A run or step in `waiting_resource` has no path to `blocked` when the retry budget is spent
  (architecture.md §9); today only a running run can block.
- A step cannot be paused from `waiting_approval` (the run can).
- A step's `wait_approval` event is not tied to an attempt generation, unlike `succeed`, `fail`,
  `interrupt` and `wait_resource`.

## Consequences

- Use cases (OMI-012, -018, -033, -034 and later) load state, build the event, call the domain
  function, persist with compare-and-swap, and never write a status column directly.
- The application layer maps parsed contracts onto domain inputs explicitly.
- `release-policy.ts` and a deploy policy are not part of this Issue; the approval subjects and
  `evaluateMerge` (`kind: "release"`) are the base they build on.
- Reason codes are a stable vocabulary: adding one is additive, renaming one is a breaking change
  for callers and for stored audit events.
