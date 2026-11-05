CREATE TABLE stream_head (id INTEGER PRIMARY KEY CHECK (id = 1), events_seq INTEGER NOT NULL, changes_seq INTEGER NOT NULL);
INSERT INTO stream_head (id, events_seq, changes_seq) VALUES (1, 0, 0);

CREATE TABLE changes_low_water (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
INSERT INTO changes_low_water (id, seq) VALUES (1, 0);

CREATE TABLE rows (
  collection TEXT NOT NULL, key TEXT NOT NULL, doc TEXT NOT NULL,
  PRIMARY KEY (collection, key)
) WITHOUT ROWID;

CREATE TABLE events (
  seq INTEGER PRIMARY KEY, aggregate TEXT NOT NULL, aggregate_id TEXT NOT NULL, job_id TEXT,
  kind TEXT NOT NULL, who TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, command_id TEXT NOT NULL
);
CREATE INDEX events_job_seq ON events (job_id, seq);

CREATE TABLE changes (
  seq INTEGER PRIMARY KEY, topic TEXT NOT NULL, op TEXT NOT NULL, key TEXT NOT NULL, doc TEXT, at INTEGER NOT NULL
);

CREATE TABLE session_output (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, item TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY, kind TEXT NOT NULL, issuer_kind TEXT NOT NULL, issuer_id TEXT NOT NULL,
  received_at INTEGER NOT NULL, epoch INTEGER NOT NULL, status TEXT NOT NULL, result TEXT, first_seq INTEGER
);
