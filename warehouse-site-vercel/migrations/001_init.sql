-- موقع المستودع: الجداول الأساسية.
-- كل الأوقات تُخزَّن UTC بصيغة ISO-8601 (مثل 2026-11-18T07:05:00.000Z) وتُعرض بتوقيت الرياض.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('warehouse', 'admin')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- الموصلون (شركة خارجية): قائمة ثابتة تديرها الإدارة — إيقاف بدل حذف
CREATE TABLE couriers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE documents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type          TEXT NOT NULL,
  doc_no            TEXT UNIQUE,            -- فارغ حتى يُعرف رقم الفسح من ملفات حقيقية
  sales_order_no    TEXT,
  customer_number   TEXT,
  customer_name     TEXT,
  doc_date          TEXT,
  status            TEXT NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received', 'preparing', 'prepared', 'handed_to_courier')),
  meta_problems     TEXT NOT NULL DEFAULT '[]',
  modified_flag     INTEGER NOT NULL DEFAULT 0,
  received_at       TEXT NOT NULL,
  prep_started_at   TEXT,
  prepared_at       TEXT,
  handed_over_at    TEXT,
  preparer_user_id  INTEGER REFERENCES users(id),
  courier_id        INTEGER REFERENCES couriers(id),
  handed_by_user_id INTEGER REFERENCES users(id),
  has_open_shortage INTEGER NOT NULL DEFAULT 0,
  source_device     TEXT,
  source_file_name  TEXT,
  sent_at           TEXT,                   -- وقت خروجه من برنامج الإرسال
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_documents_status ON documents (status, received_at);
CREATE INDEX idx_documents_customer ON documents (customer_number);

-- ملفات الـ PDF: البصمة فريدة => نفس الملف لا يُسجَّل مرتين مهما أُعيد إرساله
CREATE TABLE document_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL UNIQUE,
  size        INTEGER NOT NULL,
  version     INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_document_files_doc ON document_files (document_id, version);

-- سجل المستند: إضافة فقط، لا تعديل ولا حذف
CREATE TABLE document_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  type        TEXT NOT NULL CHECK (type IN ('received', 'modified', 'status_change', 'note', 'shortage', 'shortage_closed', 'correction')),
  from_status TEXT,
  to_status   TEXT,
  user_id     INTEGER REFERENCES users(id),
  courier_id  INTEGER REFERENCES couriers(id),
  text        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_document_events_doc ON document_events (document_id, id);

CREATE TRIGGER document_events_no_update BEFORE UPDATE ON document_events
BEGIN SELECT RAISE(ABORT, 'document_events is append-only'); END;

CREATE TRIGGER document_events_no_delete BEFORE DELETE ON document_events
BEGIN SELECT RAISE(ABORT, 'document_events is append-only'); END;

-- رسائل واتساب المنتظرة (يسحبها برنامج الإرسال) — تُستخدم في المرحلة 3
CREATE TABLE wa_notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id     INTEGER REFERENCES documents(id),
  event_id        INTEGER REFERENCES document_events(id),
  target          TEXT NOT NULL CHECK (target IN ('warehouse_group', 'customer_group')),
  customer_number TEXT,
  text            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed', 'skipped', 'expired')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  sent_at         TEXT
);
CREATE INDEX idx_wa_notifications_state ON wa_notifications (state, id);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  details    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);

-- جلسات الدخول (تبقى بعد إعادة تشغيل الموقع)
CREATE TABLE sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- عدّاد محاولات الدخول الخاطئة (القفل بعد عدة محاولات)
CREATE TABLE login_throttle (
  key          TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at   INTEGER NOT NULL
);
