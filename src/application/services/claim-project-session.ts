import { PROJECT_OWNER_LEASE_KEY } from "../ports/lease-store.js";
import type { LeaseStore, ProjectSession } from "../ports/lease-store.js";
import type { StateUnitOfWork } from "../ports/state-unit-of-work.js";

/** One key per project database; no PID or filesystem lock is a second authority. */
export { PROJECT_OWNER_LEASE_KEY } from "../ports/lease-store.js";
export function claimProjectSession(deps: {
  leases: LeaseStore;
  state: StateUnitOfWork;
  owner: string;
  now(): number;
  nextId(): string;
  leaseMs: number;
}): ProjectSession {
  const now = deps.now();
  const claim = deps.leases.acquire({
    resourceKey: PROJECT_OWNER_LEASE_KEY,
    owner: deps.owner,
    now: new Date(now).toISOString(),
    expiresAt: new Date(now + deps.leaseMs).toISOString(),
  });
  if (!claim.ok) throw new Error("PROJECT_OWNER_HELD");
  const fence = {
    resourceKey: claim.lease.resourceKey,
    owner: claim.lease.owner,
    generation: claim.lease.generation,
  };
  const at = () => new Date(deps.now()).toISOString();
  return {
    lease: claim.lease,
    renew: () => {
      const time = deps.now();
      return deps.leases.renew({
        ...fence,
        now: new Date(time).toISOString(),
        expiresAt: new Date(time + deps.leaseMs).toISOString(),
      }).ok;
    },
    commit: (change) => deps.state.commit({ ...change, fence, at: at() }),
    record: (kind, payload) => {
      const result = deps.state.commit({
        target: { kind: "session_event" },
        fence,
        at: at(),
        event: {
          eventId: deps.nextId(),
          kind,
          subject: fence.resourceKey,
          correlationId: fence.owner,
          payload: JSON.stringify({ ...payload, generation: fence.generation }),
        },
      });
      if (!result.ok) throw new Error(result.reason);
    },
    release: () => {
      if (!deps.leases.release({ ...fence, now: at() }).ok) throw new Error("STALE_LEASE");
    },
  };
}
