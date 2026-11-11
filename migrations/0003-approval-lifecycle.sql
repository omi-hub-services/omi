-- OMI-029: existing approvals only represent decisions, not pending/versioned requests.
-- Preserve legacy decisions; missing request_json is deliberately not executable approval evidence.
CREATE TABLE approvals_replacement (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES workflow_runs (id),
  kind TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  actor TEXT,
  channel TEXT,
  decision TEXT CHECK (decision IN ('approved', 'rejected')),
  revision TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'invalidated')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  request_json TEXT CHECK (request_json IS NULL OR json_valid(request_json)),
  CHECK (status NOT IN ('approved', 'rejected') OR (decision IS NOT NULL AND decision = status AND actor IS NOT NULL AND channel IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'pending' OR (decision IS NULL AND actor IS NULL AND channel IS NULL AND decided_at IS NULL))
) STRICT;

INSERT INTO approvals_replacement (id, run_id, kind, subject_hash, actor, channel, decision, revision, decided_at, expires_at, status)
SELECT id, run_id, kind, subject_hash, actor, channel, decision, revision, decided_at, expires_at, decision FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_replacement RENAME TO approvals;
CREATE INDEX approvals_subject ON approvals (kind, subject_hash, revision);
CREATE INDEX approvals_run ON approvals (run_id);
