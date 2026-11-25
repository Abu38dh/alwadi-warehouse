/**
 * مرفقات الفسح: سند التسليم للموصل (صورة من الجوال أو PDF).
 *  - النوع يُفحص من أول بايتات الملف (مو من الاسم): JPG / PNG / WEBP / PDF بس — هذي اللي يرسلها واتساب صح.
 *  - الملف ينحفظ أولاً (نسخة فيرسيل: داخل القاعدة)، وبعدها يتسجّل مع الفسح.
 *  - نفس الملف لأكثر من فسح (تسليم دفعة وحدة لنفس الموصل) = ملف واحد وسجل لكل فسح.
 *  - فيرسيل يرفض أي طلب أكبر من 4.5 ميقا: الصور تتصغّر في الجوال قبل الرفع، والحد هنا 4 ميقا.
 */
const crypto = require('crypto');
const storage = require('./storage');

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 5;

class AttachmentError extends Error {}

/** نوع الملف من محتواه. null = غير مقبول */
function sniffType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.subarray(0, 1024).includes('%PDF-')) return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

function cleanName(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || null;
}

/**
 * فحص الملفات المرفوعة وحفظها على القرص (بدون تسجيل في القاعدة).
 * @param {{buffer: Buffer, originalname?: string}[]} files من multer
 * @returns {{path, mime, size, sha256, name}[]}
 * @throws {AttachmentError}
 */
async function storeFiles(db, config, files) {
  const list = (files || []).filter(f => f && f.buffer && f.buffer.length);
  if (list.length === 0) throw new AttachmentError('أرفق سند التسليم (صورة أو PDF) قبل التسليم.');
  if (list.length > MAX_FILES) throw new AttachmentError(`أقصى شي ${MAX_FILES} مرفقات.`);
  const typed = list.map((f) => {
    if (f.buffer.length > MAX_BYTES) throw new AttachmentError('حجم المرفق كبير (الحد 4 ميقا).');
    const t = sniffType(f.buffer);
    if (!t) throw new AttachmentError('المرفق لازم يكون صورة (JPG أو PNG) أو ملف PDF.');
    // multer يقرأ اسم الملف latin1: نرجعه UTF-8 (الأسماء العربية)
    const name = cleanName(Buffer.from(String(f.originalname || ''), 'latin1').toString('utf8'));
    return { f, t, name };
  });
  const now = new Date();
  const relDir = `attachments/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const out = [];
  for (const { f, t, name } of typed) {
    const sha = crypto.createHash('sha256').update(f.buffer).digest('hex');
    const rel = `${relDir}/${sha}.${t.ext}`;
    await storage.putFile(db, rel, f.buffer);
    out.push({ path: rel, mime: t.mime, size: f.buffer.length, sha256: sha, name });
  }
  return out;
}

/** تسجيل الملفات المحفوظة على فسح (داخل نفس عملية التسليم). يرجع أرقام المرفقات */
async function attachToDocument(db, { docId, eventId = null, files, userId = null, kind = 'handover_receipt' }) {
  const ins = db.prepare(`
    INSERT INTO document_attachments (document_id, event_id, kind, path, mime, size, sha256, original_name, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const at = new Date().toISOString();
  const ids = [];
  for (const f of files) ids.push(Number((await ins.run(docId, eventId, kind, f.path, f.mime, f.size, f.sha256, f.name, userId, at)).lastInsertRowid));
  return ids;
}

async function listForDocument(db, docId) {
  return (await db.prepare('SELECT * FROM document_attachments WHERE document_id = ? ORDER BY id ASC').all(docId))
    .map(a => ({ ...a, isImage: a.mime.startsWith('image/') }));
}

async function getAttachment(db, id) {
  return (await db.prepare('SELECT * FROM document_attachments WHERE id = ?').get(Number(id) || 0)) || null;
}

/** محتوى الملف (Buffer) أو null */
async function fileData(db, att) {
  if (!att || !att.path) return null;
  return storage.getFile(db, String(att.path).split('\\').join('/'));
}

/** إرسال الملف للمتصفح أو للبرنامج */
async function sendFile(res, db, att, { download = false } = {}) {
  const data = await fileData(db, att);
  if (!data) return false;
  const ext = att.mime === 'application/pdf' ? 'pdf' : att.mime.split('/')[1];
  res.set({
    'Content-Type': att.mime,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="attachment-${att.id}.${ext}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(data);
  return true;
}

module.exports = { AttachmentError, MAX_BYTES, MAX_FILES, sniffType, storeFiles, attachToDocument, listForDocument, getAttachment, fileData, sendFile };
