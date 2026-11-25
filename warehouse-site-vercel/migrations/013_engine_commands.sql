-- نسخة فيرسيل: أوامر صفحات "واتساب والإرسال" لبرنامج الواتساب على جهاز الشركة (يسحبها كل 10 ثواني وينفذها)
CREATE TABLE IF NOT EXISTS engine_commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  body_json   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | taken | done | expired
  result_json TEXT,
  user_id     INTEGER,
  created_at  TEXT NOT NULL,
  taken_at    TEXT,
  done_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_engine_commands_status ON engine_commands (status, id);
