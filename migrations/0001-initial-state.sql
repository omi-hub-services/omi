-- 0001-initial-state: the omi-squad local state schema (docs/architecture/architecture.md §8).
--
-- Applied by src/infrastructure/persistence/sqlite/migration-runner.ts inside one transaction,
-- so this file must not contain BEGIN/COMMIT. Once applied anywhere it must never be edited:
-- the runner records a checksum and refuses a changed file. Add 0002-... instead.
--
-- Conventions: STRICT tables; local IDs are TEXT supplied by the application (the domain does
-- not read IDs or time implicitly); timestamps are ISO-8601 UTC TEXT; hashes are TEXT digests;
-- large content lives in files and the DB keeps only references and hashes. Foreign keys use the
-- default NO ACTION so audit-relevant rows cannot be deleted from under their children.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  repo_identity TEXT NOT NULL UNIQUE,
  github_project_node_id TEXT UNIQUE,
  config_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Latest local snapshot of one GitHub Issue; GitHub stays the source of task content/status.
CREATE TABLE task_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  issue_node_id TEXT NOT NULL,
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  content_hash TEXT NOT NULL,
  remote_updated_at TEXT NOT NULL,
  scope TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE (project_id, issue_node_id),
  UNIQUE (project_id, issue_number)
) STRICT;

CREATE TABLE task_dependencies (
  predecessor_task_id TEXT NOT NULL REFERENCES task_snapshots (id),
  successor_task_id TEXT NOT NULL REFERENCES task_snapshots (id),
  source TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  PRIMARY KEY (predecessor_task_id, successor_task_id),
  CHECK (predecessor_task_id <> successor_task_id)
) STRICT;

CREATE INDEX task_dependencies_successor ON task_dependencies (successor_task_id);

-- A run is active while closed_at IS NULL. At most one active run per task: a replacement run
-- can only be opened after the old one is closed (architecture.md §8 uniqueness).
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task_snapshots (id),
  replaces_run_id TEXT REFERENCES workflow_runs (id),
  template_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  quality_phase TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;

CREATE INDEX workflow_runs_task ON workflow_runs (task_id);
CREATE UNIQUE INDEX workflow_runs_one_active_per_task ON workflow_runs (task_id)
  WHERE closed_at IS NULL;
CREATE INDEX workflow_runs_replaces ON workflow_runs (replaces_run_id);

-- iteration distinguishes a step executed again by rework inside the same run.
CREATE TABLE step_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs (id),
  step_key TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 1 CHECK (iteration > 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'ready',
      'running',
      'waiting_approval',
      'waiting_resource',
      'succeeded',
      'failed',
      'paused',
      'interrupted',
      'cancelled'
    )
  ),
  input_hash TEXT,
  output_ref TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, step_key, iteration)
) STRICT;

-- A process reference is never a bare PID: it carries the start time and lease generation.
CREATE TABLE agent_attempts (
  id TEXT PRIMARY KEY,
  step_run_id TEXT NOT NULL REFERENCES step_runs (id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  executor_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  status TEXT NOT NULL,
  process_pid INTEGER CHECK (process_pid > 0),
  process_started_at TEXT,
  process_generation INTEGER CHECK (process_generation > 0),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (step_run_id, attempt_number),
  CHECK (
    process_pid IS NULL
    OR (process_started_at IS NOT NULL AND process_generation IS NOT NULL)
  )
) STRICT;

CREATE INDEX agent_attempts_profile ON agent_attempts (profile_id);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs (id),
  step_run_id TEXT REFERENCES step_runs (id),
  snapshot_kind TEXT NOT NULL,
  manifest_path TEXT NOT NULL UNIQUE CHECK (substr(manifest_path, 1, 1) <> '/'),
  manifest_hash TEXT NOT NULL,
  git_revision TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX checkpoints_run ON checkpoints (run_id, created_at);
CREATE INDEX checkpoints_step_run ON checkpoints (step_run_id);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE CHECK (substr(relative_path, 1, 1) <> '/'),
  content_hash TEXT NOT NULL,
  producer_attempt_id TEXT REFERENCES agent_attempts (id),
  classification TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX artifacts_producer_attempt ON artifacts (producer_attempt_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES workflow_runs (id),
  kind TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  channel TEXT NOT NULL,
  decision TEXT NOT NULL,
  revision TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE INDEX approvals_subject ON approvals (kind, subject_hash, revision);
CREATE INDEX approvals_run ON approvals (run_id);

-- Availability metadata only. No credential, token or secret column belongs here.
CREATE TABLE profile_observations (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  availability TEXT NOT NULL,
  cooldown_until TEXT,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL
) STRICT;

CREATE INDEX profile_observations_latest ON profile_observations (profile_id, observed_at);

-- One row per resource, so at most one holder (one active writer per worktree, one supervisor
-- per project). Re-acquiring bumps generation; stale completions carry an older generation.
CREATE TABLE leases (
  resource_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

-- One operation key per external action (architecture.md §8, design-patterns.md §7).
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  remote_identity TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX outbox_state ON outbox (state);

-- Append-only audit log. AUTOINCREMENT keeps sequence numbers monotonic and never reused.
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  run_id TEXT REFERENCES workflow_runs (id),
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX events_correlation ON events (correlation_id);
CREATE INDEX events_run ON events (run_id);

CREATE TRIGGER events_append_only_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events is append-only');
END;

CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events is append-only');
END;

CREATE TABLE github_mappings (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  entity_kind TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_number INTEGER CHECK (external_number > 0),
  UNIQUE (project_id, entity_kind, logical_key),
  UNIQUE (project_id, entity_kind, external_id)
) STRICT;
