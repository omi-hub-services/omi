-- 0002-state-constraints: enforce domain states and safe relative artifact paths.
-- The runner disables foreign keys before BEGIN and checks them before commit, restoring
-- enforcement afterward. Never rename an original table first: child references must keep
-- pointing at its canonical name. No triggers are attached to the tables rebuilt here;
-- events and its append-only triggers are retained unchanged.

-- Allowed statuses: domain/runs/workflow-run.ts RUN_STATUSES.
CREATE TABLE workflow_runs_replacement (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task_snapshots (id),
  replaces_run_id TEXT REFERENCES workflow_runs (id),
  template_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending', 'running', 'waiting_approval', 'waiting_resource', 'paused',
      'interrupted', 'blocked', 'succeeded', 'cancelled'
    )
  ),
  quality_phase TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;

INSERT INTO workflow_runs_replacement (id, task_id, replaces_run_id, template_hash, status, quality_phase, failure_count, version, created_at, updated_at, closed_at)
SELECT id, task_id, replaces_run_id, template_hash, status, quality_phase, failure_count, version, created_at, updated_at, closed_at FROM workflow_runs;

DROP TABLE workflow_runs;

ALTER TABLE workflow_runs_replacement RENAME TO workflow_runs;

CREATE INDEX workflow_runs_task ON workflow_runs (task_id);

CREATE UNIQUE INDEX workflow_runs_one_active_per_task ON workflow_runs (task_id)
  WHERE closed_at IS NULL;

CREATE INDEX workflow_runs_replaces ON workflow_runs (replaces_run_id);

CREATE TABLE checkpoints_replacement (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs (id),
  step_run_id TEXT REFERENCES step_runs (id),
  snapshot_kind TEXT NOT NULL,
  manifest_path TEXT NOT NULL UNIQUE CHECK (
    length(manifest_path) > 0
    AND substr(manifest_path, 1, 1) NOT IN ('/', char(92))
    AND manifest_path NOT GLOB '[A-Za-z]:*'
    AND instr('/' || replace(manifest_path, char(92), '/') || '/', '/../') = 0
  ),
  manifest_hash TEXT NOT NULL,
  git_revision TEXT,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO checkpoints_replacement (id, run_id, step_run_id, snapshot_kind, manifest_path, manifest_hash, git_revision, created_at)
SELECT id, run_id, step_run_id, snapshot_kind, manifest_path, manifest_hash, git_revision, created_at FROM checkpoints;

DROP TABLE checkpoints;

ALTER TABLE checkpoints_replacement RENAME TO checkpoints;

CREATE INDEX checkpoints_run ON checkpoints (run_id, created_at);

CREATE INDEX checkpoints_step_run ON checkpoints (step_run_id);

CREATE TABLE artifacts_replacement (
  id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE CHECK (
    length(relative_path) > 0
    AND substr(relative_path, 1, 1) NOT IN ('/', char(92))
    AND relative_path NOT GLOB '[A-Za-z]:*'
    AND instr('/' || replace(relative_path, char(92), '/') || '/', '/../') = 0
  ),
  content_hash TEXT NOT NULL,
  producer_attempt_id TEXT REFERENCES agent_attempts (id),
  classification TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO artifacts_replacement (id, relative_path, content_hash, producer_attempt_id, classification, created_at)
SELECT id, relative_path, content_hash, producer_attempt_id, classification, created_at FROM artifacts;

DROP TABLE artifacts;

ALTER TABLE artifacts_replacement RENAME TO artifacts;

CREATE INDEX artifacts_producer_attempt ON artifacts (producer_attempt_id);

-- Approval.decision is a recorded decision (approved/rejected), not ApprovalStatus.
CREATE TABLE approvals_replacement (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES workflow_runs (id),
  kind TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  channel TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  revision TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;

INSERT INTO approvals_replacement (id, run_id, kind, subject_hash, actor, channel, decision, revision, decided_at, expires_at)
SELECT id, run_id, kind, subject_hash, actor, channel, decision, revision, decided_at, expires_at FROM approvals;

DROP TABLE approvals;

ALTER TABLE approvals_replacement RENAME TO approvals;

CREATE INDEX approvals_subject ON approvals (kind, subject_hash, revision);

CREATE INDEX approvals_run ON approvals (run_id);
