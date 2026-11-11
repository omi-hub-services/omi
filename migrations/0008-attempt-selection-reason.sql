-- NULL on legacy attempts means the selection reason was not recorded.
ALTER TABLE agent_attempts ADD COLUMN selection_reason TEXT;
