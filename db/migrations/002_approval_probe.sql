-- Adds what protocol steps 2 and 3 need per call: approval flags and the reconcile probe name.
ALTER TABLE tool_calls
  ADD COLUMN requires_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN approved          boolean NOT NULL DEFAULT false,
  ADD COLUMN probe             text;