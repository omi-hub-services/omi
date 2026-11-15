-- Business checkpoints are written in two phases (row `pending`, then file, then `valid`), so a
-- crash between the file and the row is visible. Reconcile marks what it cannot prove consistent
-- `interrupted`; only `valid` rows may be resumed from. Additive: no table is rebuilt.
--
-- Rows that predate this migration were never verified against their file, so they default to
-- `interrupted` rather than being trusted. Every new insert states its status explicitly.
ALTER TABLE checkpoints ADD COLUMN status TEXT NOT NULL DEFAULT 'interrupted'
  CHECK (status IN ('pending', 'valid', 'interrupted'));
ALTER TABLE checkpoints ADD COLUMN status_changed_at TEXT;

CREATE INDEX checkpoints_status ON checkpoints (run_id, status, created_at);
