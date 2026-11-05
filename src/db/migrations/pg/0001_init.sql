CREATE TABLE stream_head (id INTEGER PRIMARY KEY CHECK (id = 1), events_seq BIGINT NOT NULL, changes_seq BIGINT NOT NULL);
INSERT INTO stream_head (id, events_seq, changes_seq) VALUES (1, 0, 0);

CREATE TABLE changes_low_water (id INTEGER PRIMARY KEY CHECK (id = 1), seq BIGINT NOT NULL);
INSERT INTO changes_low_water (id, seq) VALUES (1, 0);

CREATE TABLE rows (
  collection TEXT NOT NULL, key TEXT NOT NULL, doc JSONB NOT NULL,
  PRIMARY KEY (collection, key)
);

CREATE TABLE events (
  seq BIGINT PRIMARY KEY, aggregate TEXT NOT NULL, aggregate_id TEXT NOT NULL, job_id TEXT,
  kind TEXT NOT NULL, who TEXT NOT NULL, body JSONB NOT NULL, at BIGINT NOT NULL, command_id TEXT NOT NULL
);
CREATE INDEX events_job_seq ON events (job_id, seq);

CREATE TABLE changes (
  seq BIGINT PRIMARY KEY, topic TEXT NOT NULL, op TEXT NOT NULL, key TEXT NOT NULL, doc JSONB, at BIGINT NOT NULL
);

CREATE TABLE session_output (
  session_id TEXT NOT NULL, seq BIGINT NOT NULL, item JSONB NOT NULL, at BIGINT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY, kind TEXT NOT NULL, issuer_kind TEXT NOT NULL, issuer_id TEXT NOT NULL,
  received_at BIGINT NOT NULL, epoch BIGINT NOT NULL, status TEXT NOT NULL, result JSONB, first_seq BIGINT
);
