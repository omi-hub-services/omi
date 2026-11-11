-- Append validated metadata snapshots to the existing observation history. Legacy observations
-- lack registry configuration and remain history; they cannot silently become ready profiles.
ALTER TABLE profile_observations ADD COLUMN metadata_json TEXT
  CHECK (metadata_json IS NULL OR json_valid(metadata_json));
CREATE INDEX profile_observations_registry ON profile_observations (profile_id, id DESC)
  WHERE metadata_json IS NOT NULL;

-- model_id already records the explicitly selected CLI model. NULL effort on old attempts
-- means unknown, never a guessed default. Actual settings are only what the CLI reported.
ALTER TABLE agent_attempts ADD COLUMN chosen_effort TEXT
  CHECK (chosen_effort IS NULL OR chosen_effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
ALTER TABLE agent_attempts ADD COLUMN actual_model TEXT;
ALTER TABLE agent_attempts ADD COLUMN actual_effort TEXT
  CHECK (actual_effort IS NULL OR actual_effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
