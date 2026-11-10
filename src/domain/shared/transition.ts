/**
 * Explicit state-machine core (design-patterns.md §4). A machine is a plain table of rules:
 * source state, event, precondition and target state. There is no hidden transition: a pair
 * (state, event) without a rule is refused with `TRANSITION_NOT_ALLOWED`, and a failed
 * precondition is refused with the reason code that precondition returns.
 *
 * Pure: the caller loads the current state, passes the facts the precondition needs inside the
 * event (time included), persists the new state with compare-and-swap, and writes the audit.
 */

/** An event is a tagged object; the payload carries every fact its preconditions read. */
export interface DomainEvent {
  readonly type: string;
}

export interface TransitionRule<S extends string, Ev extends DomainEvent, R extends string> {
  readonly from: S;
  readonly event: Ev["type"];
  readonly to: S;
  /** Returns a reason code when the precondition does not hold, otherwise `undefined`. */
  readonly precondition?: (event: Ev) => R | undefined;
}

export type TransitionOutcome<S extends string, R extends string> =
  | { readonly ok: true; readonly from: S; readonly to: S }
  | {
      readonly ok: false;
      readonly from: S;
      readonly reason: R | "TRANSITION_NOT_ALLOWED";
    };

/**
 * Returns a rule factory typed for one machine, so each precondition sees the payload of the
 * event it is declared for: `rule("ready", "start", "running", (e) => e.leaseHeld ? undefined : "NO_LEASE")`.
 */
export function ruleBuilder<S extends string, Ev extends DomainEvent, R extends string>() {
  return <K extends Ev["type"]>(
    from: S,
    type: K,
    to: S,
    precondition?: (event: Extract<Ev, { readonly type: K }>) => R | undefined,
  ): TransitionRule<S, Ev, R> =>
    precondition === undefined
      ? { from, event: type, to }
      : { from, event: type, to, precondition: precondition as (event: Ev) => R | undefined };
}

export function applyTransition<S extends string, Ev extends DomainEvent, R extends string>(
  rules: readonly TransitionRule<S, Ev, R>[],
  from: S,
  event: Ev,
): TransitionOutcome<S, R> {
  const rule = rules.find((candidate) => candidate.from === from && candidate.event === event.type);
  if (rule === undefined) {
    return { ok: false, from, reason: "TRANSITION_NOT_ALLOWED" };
  }
  const reason = rule.precondition?.(event);
  if (reason !== undefined) {
    return { ok: false, from, reason };
  }
  return { ok: true, from, to: rule.to };
}
