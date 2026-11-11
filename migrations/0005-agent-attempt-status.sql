-- Matches domain/runs/agent-attempt.ts. Invalid legacy rows abort the migration.
-- Rebuild without renaming the old table, preserving incoming artifact references.
CREATE TABLE agent_attempts_replacement (
  id TEXT PRIMARY KEY,
  step_run_id TEXT NOT NULL REFERENCES step_runs (id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  executor_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled')),
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

INSERT INTO agent_attempts_replacement SELECT * FROM agent_attempts;
DROP TABLE agent_attempts;
ALTER TABLE agent_attempts_replacement RENAME TO agent_attempts;
CREATE INDEX agent_attempts_profile ON agent_attempts (profile_id);
