-- Keep quality state on its owning workflow run; operational retry budgets remain separate.
ALTER TABLE workflow_runs ADD COLUMN architect_intervention_id TEXT;
ALTER TABLE workflow_runs ADD COLUMN counted_cycle_ids TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(counted_cycle_ids) AND json_type(counted_cycle_ids) = 'array');
ALTER TABLE workflow_runs ADD COLUMN reopen_decision_ids TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(reopen_decision_ids) AND json_type(reopen_decision_ids) = 'array');
-- The pre-controller placeholder denotes the initial quality phase, not a spent budget.
UPDATE workflow_runs SET quality_phase = 'normal' WHERE quality_phase = 'implementation';
