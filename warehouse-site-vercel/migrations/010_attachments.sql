-- مرفقات الفسح (سند التسليم للموصل: صورة أو PDF). تنرسل مع رسالة "تم الشحن" لقروب العميل.
CREATE TABLE document_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id   INTEGER NOT NULL REFERENCES documents(id),
  event_id      INTEGER REFERENCES document_events(id),
  kind          TEXT NOT NULL DEFAULT 'handover_receipt',
  path          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  original_name TEXT,
  user_id       INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_document_attachments_doc ON document_attachments (document_id, id);

-- رسالة العميل ومعها مرفقات (أرقام المرفقات JSON)
ALTER TABLE wa_notifications ADD COLUMN attachment_ids TEXT;
