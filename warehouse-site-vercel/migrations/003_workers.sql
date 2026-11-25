-- الموظفون اللي يجهّزون الطلبات: أسماء فقط (بدون حسابات). الاسم ينكتب أو ينختار وقت "بدء التجهيز".
CREATE TABLE workers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_workers_name ON workers (name COLLATE NOCASE);

-- الموصلون: الاسم ما يتكرر (الموقع كان يمنع التكرار من قبل، فالبيانات الموجودة سليمة)
CREATE UNIQUE INDEX idx_couriers_name ON couriers (name COLLATE NOCASE);

-- مين يجهّز المستند (الموظف) — غير الحساب اللي ضغط الزر (preparer_user_id يبقى للسجل)
ALTER TABLE documents ADD COLUMN preparer_worker_id INTEGER REFERENCES workers(id);
ALTER TABLE document_events ADD COLUMN worker_id INTEGER REFERENCES workers(id);
