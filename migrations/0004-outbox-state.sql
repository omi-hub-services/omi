-- 0003-outbox-state: enforce the outbox operation states and keep retry bookkeeping.
-- Allowed states: domain/delivery/outbox-operation.ts OUTBOX_STATES (a test pins the two).
-- Moved here from OMI-054 (#73): the domain had no outbox state machine until OMI-024.
--
-- outbox is rebuilt because SQLite cannot add a CHECK in place. No other table references it
-- and no trigger is attached to it. A row whose state is not in the list makes the INSERT fail,
-- and the runner then rolls the whole migration back: stored data is never rewritten or guessed.
--
-- New columns, both NULL for rows that existed before:
--   next_attempt_at  ISO-8601 UTC time before which the operation must not be sent again
--                    (Retry-After, rate-limit reset, backoff).
--   last_error       short code of the last refusal or failure, never a message from the remote.

CREATE TABLE outbox_replacement (
  id INTEGER PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'in_flight', 'outcome_unknown', 'succeeded', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  remote_identity TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (state <> 'succeeded' OR (remote_identity IS NOT NULL AND length(remote_identity) > 0))
) STRICT;

INSERT INTO outbox_replacement (id, operation_key, kind, subject, payload_ref, payload_hash, state, attempt_count, remote_identity, created_at, updated_at)
SELECT id, operation_key, kind, subject, payload_ref, payload_hash, state, attempt_count, remote_identity, created_at, updated_at FROM outbox;

DROP TABLE outbox;

ALTER TABLE outbox_replacement RENAME TO outbox;

CREATE INDEX outbox_state ON outbox (state);
