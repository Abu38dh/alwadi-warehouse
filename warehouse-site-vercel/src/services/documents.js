/**
 * المستندات: استقبالها من برنامج الإرسال (بدون تكرار) وقراءتها للعرض.
 */
const crypto = require('crypto');
const { formatWhen, durationSince } = require('./time');
const notifications = require('./notifications');
const storage = require('./storage');
const { mainBranchName, allBranches, branchName } = require('./branches');

const STATUSES = ['received', 'preparing', 'prepared', 'handed_to_courier'];
const STATUS_LABELS = {
  received: 'جديدة',
  preparing: 'قيد التجهيز',
  prepared: 'جاهزة',
  handed_to_courier: 'سُلّمت للموصل'
};
// التبويبات في صفحة المستندات (المفتوحة فقط) — مع شرح قصير لكل مرحلة
const OPEN_TABS = [
  { status: 'received', label: 'جديدة', hint: 'لم يبدأ تجهيزها' },
  { status: 'preparing', label: 'قيد التجهيز', hint: 'تتجهز الحين' },
  { status: 'prepared', label: 'جاهزة', hint: 'تنتظر الموصل' }
];
// تبويب إضافي للإدارة فقط
const HANDED_TAB = { status: 'handed_to_courier', label: 'سُلّمت', hint: 'استلمها الموصل' };

// متى بدأت المرحلة الحالية (لحساب "ينتظر منذ")
const STAGE_START_SQL = "CASE d.status WHEN 'received' THEN d.received_at WHEN 'preparing' THEN d.prep_started_at WHEN 'prepared' THEN d.prepared_at ELSE d.handed_over_at END";

function tabsFor(user) {
  return user && user.role === 'admin' ? [...OPEN_TABS, HANDED_TAB] : OPEN_TABS;
}
const DOC_TYPE_LABELS = { clearance: 'فسح' };
// الفسح فقط يذهب للمستودع (قرار نهائي)
const ACCEPTED_DOC_TYPES = new Set(['clearance']);

const PROBLEM_LABELS = {
  customer_number_missing: 'رقم العميل غير مقروء في المستند',
  customer_number_conflict: 'في المستند أكثر من رقم عميل',
  doc_no_missing: 'رقم المستند غير مقروء',
  doc_no_conflict: 'في المستند أكثر من رقم مستند'
};

class IngestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** نص نظيف بطول محدود، أو null إذا كان فارغاً */
function cleanText(value, max) {
  if (value == null) return null;
  const s = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

// اسم عام مو اسم عميل (يجي من اسم قروب مثل "عميل رقم 0004")
const GENERIC_CUSTOMER_NAME = /^(?:(?:ال)?عميل|عملاء|رقم|قروب|جروب|مجموعة|customer|client|group|no\.?|[\s\-–—_|/\\:.،,#])+$/i;

function cleanCustomerName(value, max = 150) {
  const s = cleanText(value, max);
  return s && !GENERIC_CUSTOMER_NAME.test(s) ? s : null;
}

/** آخر اسم معروف لرقم العميل (من فسوحات سابقة) — عشان الاسم يطلع نفسه في كل فسوحاته */
async function knownCustomerName(db, number) {
  if (!number) return null;
  const r = await db.prepare("SELECT customer_name FROM documents WHERE customer_number = ? AND customer_name IS NOT NULL AND customer_name != '' ORDER BY id DESC LIMIT 1").get(number);
  return r ? cleanCustomerName(r.customer_name) : null;
}

/** عدد موجب معقول أو null */
function cleanCount(value, max, decimals = false) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return decimals ? Math.round(n * 100) / 100 : Math.round(n);
}

function cleanIsoDate(value) {
  const s = cleanText(value, 40);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function cleanProblems(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(v => cleanText(v, 60)).filter(Boolean))].slice(0, 10);
}

function looksLikePdf(buf) {
  return Buffer.isBuffer(buf) && buf.length > 100 && buf.subarray(0, 1024).includes('%PDF-');
}

/**
 * استقبال مستند من برنامج الإرسال.
 *  - نفس الملف (نفس البصمة) موجود => {duplicate: true} ولا يُسجَّل شيء (إعادة الإرسال آمنة).
 *  - رقم مستند موجود بملف مختلف => نسخة جديدة لنفس المستند وعلامة "تعدّل".
 *  - غير ذلك => مستند جديد بحالة "وصل للمستودع".
 * @returns {{status: 200|201, body: object}}
 * @throws {IngestError} عند ملف أو بيانات غير مقبولة
 */
async function ingestDocument(db, config, { pdfBuffer, meta }) {
  if (!looksLikePdf(pdfBuffer)) throw new IngestError(400, 'not_pdf', 'الملف ليس PDF صالحاً');
  if (pdfBuffer.length > config.maxPdfBytes) throw new IngestError(413, 'too_large', 'حجم الملف أكبر من المسموح');
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new IngestError(400, 'invalid_meta', 'بيانات المستند غير صحيحة');

  const sha = sha256(pdfBuffer);
  if (meta.sha256 && String(meta.sha256).toLowerCase() !== sha) {
    throw new IngestError(400, 'sha_mismatch', 'بصمة الملف لا تطابق الملف المستلم');
  }
  const docType = cleanText(meta.doc_type, 30);
  if (!ACCEPTED_DOC_TYPES.has(docType)) throw new IngestError(422, 'doc_type_not_accepted', 'نوع المستند غير مقبول في المستودع');

  const existingFile = await db.prepare('SELECT document_id, version FROM document_files WHERE sha256 = ?').get(sha);
  if (existingFile) {
    return { status: 200, body: { ok: true, duplicate: true, id: existingFile.document_id, version: existingFile.version, sha256: sha } };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const fields = {
    doc_no: cleanText(meta.doc_no, 60),
    sales_order_no: cleanText(meta.sales_order_no, 60),
    customer_number: cleanText(meta.customer_number, 30),
    customer_name: cleanCustomerName(meta.customer_name) || await knownCustomerName(db, cleanText(meta.customer_number, 30)),
    doc_date: cleanText(meta.doc_date, 30),
    sent_at: cleanIsoDate(meta.sent_at),
    source_device: cleanText(meta.source_device, 100),
    // فرع الجهاز اللي طبع المستند (المستندات من أجهزة الجهاز الرئيسي نفسه = فرعه)
    branch: branchName(cleanText(meta.branch, 40)) || await mainBranchName(db),
    source_file_name: cleanText(meta.file_name, 200),
    meta_problems: JSON.stringify(cleanProblems(meta.meta_problems)),
    // عدد الأصناف ومجموع الكميات (اختياري — من البرنامج لو قرا جدول الأصناف)
    items_count: cleanCount(meta.items_count, 10000),
    items_qty: cleanCount(meta.items_qty, 10000000, true)
  };

  // الملف أولاً (داخل القاعدة) ثم التسجيل — لا يوجد سجل بدون ملف
  const relPath = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${sha}.pdf`;
  await storage.putFile(db, relPath, pdfBuffer);

  const result = await db.transaction(async (tx) => {
    const existingDoc = fields.doc_no ? await tx.prepare('SELECT id FROM documents WHERE doc_no = ?').get(fields.doc_no) : null;
    if (existingDoc) {
      // نفس رقم المستند بملف مختلف: نسخة جديدة، ولا تتغير الحالة ولا يُحذف شيء
      const version = (await tx.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM document_files WHERE document_id = ?').get(existingDoc.id)).v;
      await tx.prepare('INSERT INTO document_files (document_id, path, sha256, size, version, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(existingDoc.id, relPath, sha, pdfBuffer.length, version, nowIso);
      await tx.prepare('UPDATE documents SET modified_flag = 1 WHERE id = ?').run(existingDoc.id);
      await tx.prepare("INSERT INTO document_events (document_id, type, text, created_at) VALUES (?, 'modified', ?, ?)")
        .run(existingDoc.id, `وصلت نسخة معدّلة من المستند (النسخة ${version})`, nowIso);
      // النسخة الجديدة فيها رقم العميل: هي الأصح (لو انطبع الفسح من جديد بعميل مصحّح)
      // بدون رقم عميل (ما انقرأ): يبقى اللي عندنا
      if (fields.sales_order_no) await tx.prepare('UPDATE documents SET sales_order_no = ? WHERE id = ?').run(fields.sales_order_no, existingDoc.id);
      if (fields.items_count) await tx.prepare('UPDATE documents SET items_count = ?, items_qty = ? WHERE id = ?').run(fields.items_count, fields.items_qty, existingDoc.id);
      if (fields.customer_number) {
        const old = await tx.prepare('SELECT customer_number, customer_name FROM documents WHERE id = ?').get(existingDoc.id);
        await tx.prepare('UPDATE documents SET customer_number = ?, customer_name = ?, meta_problems = ? WHERE id = ?')
          .run(fields.customer_number, fields.customer_name || (old.customer_number === fields.customer_number ? old.customer_name : null), fields.meta_problems, existingDoc.id);
        if (old.customer_number !== fields.customer_number) {
          await tx.prepare("INSERT INTO document_events (document_id, type, text, created_at) VALUES (?, 'note', ?, ?)")
            .run(existingDoc.id, `تغيّر العميل في النسخة الجديدة: ${old.customer_number || 'غير معروف'} ← ${fields.customer_number}`, nowIso);
        }
      }
      return { id: existingDoc.id, version, modified: true };
    }
    const info = await tx.prepare(`
      INSERT INTO documents (doc_type, doc_no, sales_order_no, customer_number, customer_name, doc_date, status,
                             meta_problems, received_at, source_device, source_file_name, sent_at, branch, created_at, items_count, items_qty)
      VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(docType, fields.doc_no, fields.sales_order_no, fields.customer_number, fields.customer_name, fields.doc_date,
      fields.meta_problems, nowIso, fields.source_device, fields.source_file_name, fields.sent_at, fields.branch, nowIso, fields.items_count, fields.items_qty);
    const id = Number(info.lastInsertRowid);
    await tx.prepare('INSERT INTO document_files (document_id, path, sha256, size, version, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(id, relPath, sha, pdfBuffer.length, nowIso);
    const eventInfo = await tx.prepare("INSERT INTO document_events (document_id, type, to_status, text, created_at) VALUES (?, 'received', 'received', ?, ?)")
      .run(id, 'وصل المستند للمستودع', nowIso);
    await notifications.enqueueForEvent(tx, { docId: id, eventType: 'received', eventId: Number(eventInfo.lastInsertRowid) });
    return { id, version: 1, modified: false };
  });

  return { status: 201, body: { ok: true, duplicate: false, id: result.id, version: result.version, modified: result.modified, sha256: sha } };
}

// ---------- القراءة ----------

function parseProblems(row) {
  try { const p = JSON.parse(row.meta_problems || '[]'); return Array.isArray(p) ? p : []; } catch (_) { return []; }
}

/** عنوان المستند: رقمه إن عُرف، وإلا رقمه التسلسلي في الموقع ("فسح رقم 12") */
function docTitle({ id, doc_no, doc_type }) {
  const typeLabel = DOC_TYPE_LABELS[doc_type] || 'مستند';
  // الرقم الحقيقي (من المستند) يظهر كما هو، والرقم الداخلي للموقع بعلامة # عشان ما يتلخبط معه
  return doc_no ? `${typeLabel} ${doc_no}` : `${typeLabel} #${id}`;
}

/** متى بدأت المرحلة الحالية للمستند */
function stageStartedAt(row) {
  return { received: row.received_at, preparing: row.prep_started_at, prepared: row.prepared_at, handed_to_courier: row.handed_over_at }[row.status] || row.received_at;
}

/** وصف المرحلة الحالية بكلام واضح: "ينتظر بدء التجهيز منذ 12 دقيقة" */
function stageText(doc, now = Date.now()) {
  switch (doc.status) {
    case 'received': return `ينتظر بدء التجهيز منذ ${durationSince(doc.received_at, now)}`;
    case 'preparing': return `يتجهز منذ ${durationSince(doc.prep_started_at || doc.received_at, now)}${doc.preparer_name ? ` — يجهّزه ${doc.preparer_name}` : ''}`;
    case 'prepared': return `ينتظر الموصل منذ ${durationSince(doc.prepared_at || doc.received_at, now)}`;
    case 'handed_to_courier': return `انسلّم ${formatWhen(doc.handed_over_at, now)}`;
    default: return '';
  }
}

/** إضافة الحقول المشتقة للعرض (العنوان، الملاحظات على البيانات) */
function present(row) {
  if (!row) return null;
  const problems = parseProblems(row);
  const typeLabel = DOC_TYPE_LABELS[row.doc_type] || 'مستند';
  return {
    ...row,
    problems,
    problemLabels: problems.map(p => PROBLEM_LABELS[p] || p),
    typeLabel,
    title: docTitle(row),
    statusLabel: STATUS_LABELS[row.status] || row.status,
    stageStartedAt: stageStartedAt(row)
  };
}

// preparer_name = الموظف اللي يجهّز (وللمستندات القديمة قبل إضافة الموظفين: الحساب اللي بدأ التجهيز)
const DOC_SELECT = `
  SELECT d.*, COALESCE(w.name, pu.full_name) AS preparer_name, pu.full_name AS started_by_name,
         hu.full_name AS handed_by_name, c.name AS courier_name
  FROM documents d
  LEFT JOIN workers w ON w.id = d.preparer_worker_id
  LEFT JOIN users pu ON pu.id = d.preparer_user_id
  LEFT JOIN users hu ON hu.id = d.handed_by_user_id
  LEFT JOIN couriers c ON c.id = d.courier_id
`;

async function listByStatus(db, status, branch = null) {
  const b = branchWhere(branch);
  if (status === 'handed_to_courier') {
    // المسلّمة: الأحدث أولاً (آخر 200)
    return (await db.prepare(`${DOC_SELECT} WHERE d.status = ?${b.sql} ORDER BY d.handed_over_at DESC, d.id DESC LIMIT 200`).all(status, ...b.params)).map(present);
  }
  // المفتوحة: الأقدم أولاً — اللي وصل أول يتجهز أول
  return (await db.prepare(`${DOC_SELECT} WHERE d.status = ?${b.sql} ORDER BY d.received_at ASC, d.id ASC LIMIT 500`).all(status, ...b.params)).map(present);
}

/**
 * كل الفسوحات في قائمة وحدة (التايم لاين يبيّن مرحلة كل فسح):
 * المفتوحة أولاً — الأقدم فوق (اللي وصل أول يتجهز أول)، وبعدها المسلّمة (للإدارة) — الأحدث فوق.
 */
async function listAll(db, branch = null, { includeHanded = false } = {}) {
  const b = branchWhere(branch);
  const open = (await db.prepare(`${DOC_SELECT} WHERE d.status IN ('received', 'preparing', 'prepared')${b.sql} ORDER BY d.received_at ASC, d.id ASC LIMIT 500`).all(...b.params)).map(present);
  if (!includeHanded) return open;
  const handed = (await db.prepare(`${DOC_SELECT} WHERE d.status = 'handed_to_courier'${b.sql} ORDER BY d.handed_over_at DESC, d.id DESC LIMIT 100`).all(...b.params)).map(present);
  return open.concat(handed);
}

/** شرط الفرع (null = كل الفروع) */
function branchWhere(branch, alias = 'd') {
  return branch ? { sql: ` AND ${alias}.branch = ?`, params: [branch] } : { sql: '', params: [] };
}

/** فرع المستخدم: مسؤول المستودع المربوط بفرع يشوف فرعه فقط؛ الإدارة (والحساب بدون فرع) = كل الفروع */
function userBranch(user) {
  return user && user.role === 'warehouse' && user.branch ? user.branch : null;
}

/** مستندات محددة بأرقامها (لشاشة التسليم) */
async function listByIds(db, ids) {
  const clean = [...new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 200);
  if (clean.length === 0) return [];
  return (await db.prepare(`${DOC_SELECT} WHERE d.id IN (${clean.map(() => '?').join(',')})`).all(...clean)).map(present);
}

/**
 * البحث: برقم المستند في الموقع (12 أو #12)، رقم العميل أو اسمه، رقم الفسح أو أمر البيع، أو اسم الموصل.
 * includeHanded = false لمسؤول المستودع (المفتوحة فقط).
 */
async function search(db, query, { includeHanded, branch = null }) {
  const q = String(query || '').trim().slice(0, 60);
  if (!q) return [];
  // "#7" = الرقم الداخلي للموقع بس (بالضبط)
  const internal = /^#\s*(\d{1,9})$/.exec(q);
  let where;
  const params = {};
  let order = 'd.received_at DESC, d.id DESC';
  if (internal) {
    where = '(d.id = @id)';
    params.id = Number(internal[1]);
  } else {
    params.like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const fields = ['d.customer_name', 'd.customer_number', 'd.doc_no', 'd.sales_order_no', 'c.name', 'w.name', 'd.branch'];
    let cond = fields.map(f => `${f} LIKE @like ESCAPE '\\'`).join(' OR ');
    // رقم بس: الرقم الداخلي يطابق بالضبط (7 ما تجيب 17 ولا 70)، واللي يطابق بالضبط يطلع أول
    const num = /^(?:رقم)?\s*(\d{1,12})$/.exec(q);
    if (num) {
      params.exact = num[1];
      params.id = Number(num[1]);
      cond += ' OR d.id = @id';
      order = '(d.doc_no = @exact OR d.customer_number = @exact OR d.sales_order_no = @exact OR (d.doc_no IS NULL AND d.id = @id)) DESC, ' + order;
    }
    where = `(${cond})`;
  }
  if (!includeHanded) where += " AND d.status != 'handed_to_courier'";
  if (branch) { where += ' AND d.branch = @branch'; params.branch = branch; }
  return (await db.prepare(`${DOC_SELECT} WHERE ${where} ORDER BY ${order} LIMIT 100`).all(params)).map(present);
}

/** المستندات المفتوحة الأطول انتظاراً في مرحلتها الحالية */
async function listLongestWaiting(db, limit = 6, branch = null) {
  const b = branchWhere(branch);
  return (await db.prepare(`${DOC_SELECT} WHERE d.status != 'handed_to_courier'${b.sql} ORDER BY ${STAGE_START_SQL} ASC, d.id ASC LIMIT ?`).all(...b.params, limit)).map(present);
}

/** المستندات المفتوحة التي بياناتها ناقصة (رقم العميل غير مقروء مثلاً) */
async function listMissingData(db, limit = 20, branch = null) {
  const b = branchWhere(branch);
  return (await db.prepare(`${DOC_SELECT} WHERE d.status != 'handed_to_courier' AND d.meta_problems != '[]'${b.sql} ORDER BY d.received_at ASC LIMIT ?`).all(...b.params, limit)).map(present);
}

async function countsByStatus(db, branch = null) {
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  const b = branchWhere(branch, 'documents');
  for (const r of await db.prepare(`SELECT status, COUNT(*) AS n FROM documents WHERE 1 = 1${b.sql} GROUP BY status`).all(...b.params)) counts[r.status] = r.n;
  return counts;
}

async function latestDocumentId(db, branch = null) {
  const b = branchWhere(branch, 'documents');
  return (await db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM documents WHERE 1 = 1${b.sql}`).get(...b.params)).id;
}

/** أسماء الفروع (نفس قائمة "أجهزة المحاسبين") */
async function knownBranches(db) {
  return allBranches(db);
}

class CustomerError extends Error {}

/**
 * الإدارة تصحح العميل في فسح رقم عميله غير مقروء (أو غلط).
 * المشكلة تنشال من "بيانات ناقصة"، والتصحيح ينسجل في سجل الفسح (من وإلى ومين).
 * رسائل حالة الطلب الجاية تروح لقروب العميل الصحيح.
 */
async function setCustomer(db, { docId, number, name, user }) {
  const num = String(number == null ? '' : number).replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/\s+/g, '').trim();
  if (!/^\d{1,12}$/.test(num)) throw new CustomerError('رقم العميل لازم يكون أرقام بس.');
  // بدون اسم: آخر اسم معروف لنفس الرقم (عشان يطلع نفسه في كل فسوحاته)
  const cleanName = cleanCustomerName(name, 80) || await knownCustomerName(db, num);
  return db.transaction(async (tx) => {
    const row = await tx.prepare('SELECT id, customer_number, customer_name, meta_problems FROM documents WHERE id = ?').get(docId);
    if (!row) throw new CustomerError('الفسح غير موجود.');
    let problems = [];
    try { problems = JSON.parse(row.meta_problems || '[]'); } catch (_) {}
    problems = (Array.isArray(problems) ? problems : []).filter(p => p !== 'customer_number_missing' && p !== 'customer_number_conflict');
    const newName = cleanName || (row.customer_number === num ? row.customer_name : null);
    await tx.prepare('UPDATE documents SET customer_number = ?, customer_name = ?, meta_problems = ? WHERE id = ?').run(num, newName, JSON.stringify(problems), docId);
    const before = row.customer_number ? `${row.customer_name ? `${row.customer_name} — ` : ''}${row.customer_number}` : 'غير معروف';
    const after = `${newName ? `${newName} — ` : ''}${num}`;
    await tx.prepare("INSERT INTO document_events (document_id, type, user_id, text, created_at) VALUES (?, 'note', ?, ?, ?)")
      .run(docId, user.id, `الإدارة صحّحت العميل: من ${before} إلى ${after}`, new Date().toISOString());
    return { number: num, name: newName };
  });
}

async function getDocument(db, id) {
  return present(await db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id));
}

/**
 * مسؤول المستودع يشوف المستندات المفتوحة فقط، ومن فرعه فقط (إذا حسابه مربوط بفرع).
 * المسلّمة للموصل للإدارة.
 */
function canView(user, doc) {
  if (!user || !doc) return false;
  if (user.role === 'admin') return true;
  if (doc.status === 'handed_to_courier') return false;
  return inUserBranch(user, doc);
}

/** المستند من فرع المستخدم (أو المستخدم يشوف كل الفروع) — بغض النظر عن حالته */
function inUserBranch(user, doc) {
  if (!user || !doc) return false;
  const b = userBranch(user);
  return !b || doc.branch === b;
}

async function getEvents(db, documentId) {
  return db.prepare(`
    SELECT e.*, u.full_name AS user_name, c.name AS courier_name, w.name AS worker_name
    FROM document_events e
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN couriers c ON c.id = e.courier_id
    LEFT JOIN workers w ON w.id = e.worker_id
    WHERE e.document_id = ?
    ORDER BY e.id ASC
  `).all(documentId);
}

async function getFiles(db, documentId) {
  return db.prepare('SELECT * FROM document_files WHERE document_id = ? ORDER BY version DESC').all(documentId);
}

/** محتوى ملف الفسح (Buffer) من القاعدة، أو null */
async function readFile(db, fileRow) {
  if (!fileRow || !fileRow.path) return null;
  return storage.getFile(db, String(fileRow.path).split('\\').join('/'));
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  STAGE_START_SQL,
  OPEN_TABS,
  HANDED_TAB,
  tabsFor,
  docTitle,
  stageText,
  search,
  listLongestWaiting,
  listMissingData,
  IngestError,
  ingestDocument,
  canView,
  inUserBranch,
  CustomerError,
  setCustomer,
  userBranch,
  branchWhere,
  knownBranches,
  listByIds,
  listByStatus,
  listAll,
  countsByStatus,
  latestDocumentId,
  getDocument,
  getEvents,
  getFiles,
  readFile,
  sha256
};
