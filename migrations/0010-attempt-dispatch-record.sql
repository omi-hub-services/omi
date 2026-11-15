-- Dispatch metadata supplements selector reservations. Legacy/uncompleted reservations have no
-- record; process identity and lifecycle remain authoritative in the existing columns.
ALTER TABLE agent_attempts ADD COLUMN dispatch_record TEXT
  CHECK (dispatch_record IS NULL OR json_valid(dispatch_record));
