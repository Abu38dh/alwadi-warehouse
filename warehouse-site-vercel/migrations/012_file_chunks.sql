-- نسخة فيرسيل: ما فيه قرص دائم، فملفات PDF والسندات تنحفظ داخل القاعدة (مقسّمة قطع صغيرة)
CREATE TABLE IF NOT EXISTS file_chunks (
  key   TEXT NOT NULL,
  idx   INTEGER NOT NULL,
  data  BLOB NOT NULL,
  PRIMARY KEY (key, idx)
);
