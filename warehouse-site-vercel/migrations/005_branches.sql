-- أجهزة الفروع البعيدة: ترسل المستندات عبر الإنترنت للموقع، والجهاز الرئيسي (جدة) يسحبها ويرسلها من رقم الشركة.
CREATE TABLE relay_devices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  branch          TEXT NOT NULL,
  token_hash      TEXT,
  pair_code_hash  TEXT,
  pair_expires_at TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  paired_at       TEXT,
  last_seen_at    TEXT
);

-- صندوق مؤقت: الملف ينحذف من الموقع أول ما يستلمه الجهاز الرئيسي
CREATE TABLE relay_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    INTEGER NOT NULL REFERENCES relay_devices(id),
  sha256       TEXT NOT NULL,
  file_name    TEXT,
  size         INTEGER NOT NULL,
  path         TEXT,
  status       TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'taken', 'received', 'done')),
  taken_at     TEXT,
  received_at  TEXT,
  done_at      TEXT,
  outcome_json TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (device_id, sha256)
);
CREATE INDEX idx_relay_jobs_status ON relay_jobs (status, id);

-- الفرع اللي طُبع منه المستند
ALTER TABLE documents ADD COLUMN branch TEXT;
