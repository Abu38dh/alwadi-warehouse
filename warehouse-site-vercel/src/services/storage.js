/**
 * تخزين الملفات (نسخة فيرسيل): داخل القاعدة نفسها، مقسّمة قطع 512 كيلو.
 * المفتاح مسار نسبي مثل "2026/11/<sha>.pdf" أو "attachments/<sha>.jpg".
 */
const CHUNK = 512 * 1024;

/** يحفظ الملف (لو المفتاح موجود من قبل بنفس المحتوى ما يصير شيء) */
async function putFile(db, key, buffer) {
  const exists = await db.prepare('SELECT 1 AS x FROM file_chunks WHERE key = ? AND idx = 0').get(key);
  if (exists) return;
  await db.transaction(async (tx) => {
    for (let i = 0, idx = 0; i < buffer.length || idx === 0; i += CHUNK, idx++) {
      await tx.prepare('INSERT INTO file_chunks (key, idx, data) VALUES (?, ?, ?) ON CONFLICT(key, idx) DO NOTHING')
        .run(key, idx, buffer.subarray(i, i + CHUNK));
    }
  });
}

/** يرجّع الملف كـ Buffer، أو null لو غير موجود */
async function getFile(db, key) {
  const rows = await db.prepare('SELECT data FROM file_chunks WHERE key = ? ORDER BY idx ASC').all(key);
  if (!rows.length) return null;
  return Buffer.concat(rows.map(r => r.data));
}

async function hasFile(db, key) {
  return !!(await db.prepare('SELECT 1 AS x FROM file_chunks WHERE key = ? AND idx = 0').get(key));
}

async function deleteFile(db, key) {
  await db.prepare('DELETE FROM file_chunks WHERE key = ?').run(key);
}

/** استبدال ملف بمحتوى جديد (مثل بيانات التقرير اللي تتحدث) — كله في عملية وحدة */
async function replaceFile(db, key, buffer) {
  await db.transaction(async (tx) => {
    await tx.prepare('DELETE FROM file_chunks WHERE key = ?').run(key);
    for (let i = 0, idx = 0; i < buffer.length || idx === 0; i += CHUNK, idx++) {
      await tx.prepare('INSERT INTO file_chunks (key, idx, data) VALUES (?, ?, ?)').run(key, idx, buffer.subarray(i, i + CHUNK));
    }
  });
}

module.exports = { putFile, getFile, hasFile, deleteFile, replaceFile, CHUNK };
