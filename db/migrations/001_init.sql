CREATE TABLE runs (
  run_id     uuid PRIMARY KEY,
  scenario   text NOT NULL,
  status     text NOT NULL CHECK (status IN ('RUNNING','WAITING_APPROVAL','DONE','FAILED')),
  step_no    int  NOT NULL DEFAULT 0,        -- next step to execute
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tool_calls (
  idempotency_key text PRIMARY KEY,
  run_id     uuid NOT NULL REFERENCES runs(run_id),
  step_no    int  NOT NULL,
  tool       text NOT NULL,
  args       jsonb NOT NULL,
  state      text NOT NULL CHECK (state IN
             ('PLANNED','AWAITING_APPROVAL','SENT','DONE','UNKNOWN','FAILED')),
  result     jsonb,
  attempts   int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_no)
);
CREATE INDEX tool_calls_state_idx ON tool_calls (state) WHERE state IN ('PLANNED','SENT','AWAITING_APPROVAL');