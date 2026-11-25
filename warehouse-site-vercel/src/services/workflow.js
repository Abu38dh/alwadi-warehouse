/**
 * دورة حياة المستند:
 *   وصل للمستودع ──► قيد التجهيز ──► تم التجهيز ──► سُلّم للموصل
 *
 *  - لا قفز بين المراحل: كل إجراء ينقل خطوة واحدة فقط.
 *  - حماية من ضغطتين بنفس اللحظة: التغيير ينجح فقط إذا كانت الحالة ما زالت كما رآها المستخدم
 *    (الأولى تنجح، الثانية ترى "تغيّرت الحالة").
 *  - كل تغيير يُسجَّل في document_events (من، متى، من حالة إلى حالة). لا شيء يُحذف أبداً.
 *  - الملاحظة والنقص لا يغيّران الحالة. النقص يبقى مفتوحاً حتى يُقفل مع وصف الحل.
 *  - التصحيح: خطوة واحدة للخلف مع سبب (الصلاحية تُفحص في المسار: الإدارة فقط).
 */
const { STATUS_LABELS } = require('./documents');
const { findOrCreateWorker, findOrCreateCourier } = require('./people');
const notifications = require('./notifications');
const attachments = require('./attachments');

const MAX_TEXT = 1000;

// الخطوة التالية التي ينفذها المستخدم بزر واحد (التسليم للموصل له شاشته الخاصة)
const NEXT_STEP = {
  received: { to: 'preparing', button: 'بدء التجهيز', eventText: 'بدأ التجهيز' },
  preparing: { to: 'prepared', button: 'تم التجهيز', eventText: 'تم التجهيز' }
};

const PREVIOUS_STATUS = {
  preparing: 'received',
  prepared: 'preparing',
  handed_to_courier: 'prepared'
};

const STATUS_CHANGED_MESSAGE = 'تغيّرت حالة الفسح قبل طلبك (يمكن أحد غيّرها أو انضغط الزر مرتين). هذي حالته الحالية.';

class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT);
}

function requireText(value, message) {
  const text = cleanText(value);
  if (text.length < 2) throw new WorkflowError('text_required', message);
  return text;
}

async function addEvent(db, e) {
  const info = await db.prepare(`
    INSERT INTO document_events (document_id, type, from_status, to_status, user_id, courier_id, worker_id, text, ref_event_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.documentId, e.type, e.from || null, e.to || null, e.userId || null, e.courierId || null, e.workerId || null, e.text || null, e.refEventId || null, e.at);
  return Number(info.lastInsertRowid);
}

/**
 * بدء التجهيز / تم التجهيز.
 * بدء التجهيز يحتاج اسم الموظف اللي يجهّز الطلب (من القائمة أو اسم جديد يُضاف للقائمة تلقائياً).
 */
async function advance(db, { docId, expectedStatus, user, workerName }) {
  const step = NEXT_STEP[expectedStatus];
  if (!step) throw new WorkflowError('invalid_step', 'هذا الإجراء غير متاح لهذا المستند.');
  return db.transaction(async (tx) => {
    const at = new Date().toISOString();
    let worker = null;
    let info;
    if (step.to === 'preparing') {
      // الحالة أولاً: لو تغيّرت ما ننشئ اسم جديد على الفاضي
      const docRow = await tx.prepare("SELECT branch FROM documents WHERE id = ? AND status = 'received'").get(docId);
      if (!docRow) throw new WorkflowError('status_changed', STATUS_CHANGED_MESSAGE);
      // الاسم الجديد ينحفظ لفرع المستند (موظفين الرياض ما يطلعون لمستودع جدة)
      worker = await findOrCreateWorker(tx, workerName, docRow.branch);
      if (!worker) throw new WorkflowError('worker_required', 'اختر اسم الموظف اللي يجهّز الطلب أو اكتبه.');
      info = await tx.prepare("UPDATE documents SET status = 'preparing', prep_started_at = ?, preparer_user_id = ?, preparer_worker_id = ? WHERE id = ? AND status = 'received'")
        .run(at, user.id, worker.id, docId);
    } else {
      info = await tx.prepare("UPDATE documents SET status = 'prepared', prepared_at = ? WHERE id = ? AND status = 'preparing'").run(at, docId);
    }
    if (info.changes !== 1) throw new WorkflowError('status_changed', STATUS_CHANGED_MESSAGE);
    const eventId = await addEvent(tx, { documentId: docId, type: 'status_change', from: expectedStatus, to: step.to, userId: user.id, workerId: worker && worker.id, text: step.eventText, at });
    await notifications.enqueueForEvent(tx, { docId, eventType: step.to, eventId });
    return { to: step.to, worker };
  });
}

/**
 * تسليم مستند أو أكثر لموصل واحد دفعة واحدة.
 * المستندات التي لم تعد "تم التجهيز" تُتخطى (ولا يفشل الباقي).
 * receipts: سند التسليم (ملفات محفوظة من attachments.storeFiles) — ينحفظ مع كل فسح انسلّم ويروح مع رسالة الشحن للعميل.
 * @returns {{courier: object, done: number[], skipped: number[]}}
 */
async function handOver(db, { docIds, courierId, courierName, user, receipts = [] }) {
  const ids = [...new Set((docIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) throw new WorkflowError('no_documents', 'حدّد مستنداً واحداً على الأقل.');
  if (ids.length > 200) throw new WorkflowError('too_many', 'عدد المستندات كبير، سلّمها على دفعات.');
  return db.transaction(async (tx) => {
    let courier;
    if (String(courierName || '').trim()) {
      // اسم مكتوب وقت التسليم: يُستخدم الموجود أو يُضاف لقائمة فرع المستند تلقائياً (بدون أي حساب)
      const first = await tx.prepare('SELECT branch FROM documents WHERE id = ?').get(ids[0]);
      courier = await findOrCreateCourier(tx, courierName, first ? first.branch : null);
    } else {
      courier = await tx.prepare('SELECT id, name, active, branch FROM couriers WHERE id = ?').get(Number(courierId) || 0);
      if (!courier) throw new WorkflowError('courier_required', 'اختر الموصل أو اكتب اسمه.');
      if (!courier.active) throw new WorkflowError('courier_inactive', `الموصل "${courier.name}" موقوف. اختر موصلاً آخر.`);
    }
    const at = new Date().toISOString();
    const update = tx.prepare("UPDATE documents SET status = 'handed_to_courier', handed_over_at = ?, handed_by_user_id = ?, courier_id = ? WHERE id = ? AND status = 'prepared'");
    const done = [];
    const skipped = [];
    const docBranch = tx.prepare('SELECT branch FROM documents WHERE id = ?');
    for (const id of ids) {
      // موصل فرع ثاني ما يستلم فسوحات هذا الفرع (الموصل بدون فرع = لكل الفروع)
      const doc = await docBranch.get(id);
      if (courier.branch && doc && doc.branch && doc.branch !== courier.branch) { skipped.push(id); continue; }
      if ((await update.run(at, user.id, courier.id, id)).changes === 1) {
        const eventId = await addEvent(tx, { documentId: id, type: 'status_change', from: 'prepared', to: 'handed_to_courier', userId: user.id, courierId: courier.id, text: 'سُلّم للموصل', at });
        const attachmentIds = receipts.length ? await attachments.attachToDocument(tx, { docId: id, eventId, files: receipts, userId: user.id }) : [];
        await notifications.enqueueForEvent(tx, { docId: id, eventType: 'handed_to_courier', eventId, attachmentIds });
        done.push(id);
      } else {
        skipped.push(id);
      }
    }
    // ما انسلّم شيء: يرجع كل شي زي ما كان (حتى اسم الموصل المكتوب ما ينضاف للقائمة)
    if (done.length === 0) throw new WorkflowError('status_changed', 'ما انسلّم شيء: حالة الفسح تغيّرت (يمكن انسلّم من قبل).');
    return { courier, done, skipped };
  });
}

/** تصحيح: إرجاع الحالة خطوة واحدة مع سبب. السجل يبقى كاملاً */
async function correctBack(db, { docId, expectedStatus, reason, user }) {
  const to = PREVIOUS_STATUS[expectedStatus];
  if (!to) throw new WorkflowError('invalid_step', 'هذا المستند في أول مرحلة، ما فيه خطوة قبلها.');
  const text = requireText(reason, 'اكتب سبب التصحيح.');
  return db.transaction(async (tx) => {
    // بيانات المرحلة الملغاة تُفرَّغ من المستند (وتبقى محفوظة في السجل)
    const clear = {
      preparing: 'prep_started_at = NULL, preparer_user_id = NULL, preparer_worker_id = NULL',
      prepared: 'prepared_at = NULL',
      handed_to_courier: 'handed_over_at = NULL, handed_by_user_id = NULL, courier_id = NULL'
    }[expectedStatus];
    const info = await tx.prepare(`UPDATE documents SET status = ?, ${clear} WHERE id = ? AND status = ?`).run(to, docId, expectedStatus);
    if (info.changes !== 1) throw new WorkflowError('status_changed', STATUS_CHANGED_MESSAGE);
    await addEvent(tx, { documentId: docId, type: 'correction', from: expectedStatus, to, userId: user.id, text, at: new Date().toISOString() });
    // رسالة للعميل عن مرحلة انلغت (ما انرسلت للحين) ما تروح
    await notifications.cancelPending(tx, docId, 'انلغت لأن الإدارة صحّحت حالة الطلب');
    return { to };
  });
}

async function documentExists(db, docId) {
  return !!(await db.prepare('SELECT 1 AS x FROM documents WHERE id = ?').get(docId));
}

async function addNote(db, { docId, text, user }) {
  const clean = requireText(text, 'اكتب نص الملاحظة.');
  if (!(await documentExists(db, docId))) throw new WorkflowError('not_found', 'المستند غير موجود.');
  return addEvent(db, { documentId: docId, type: 'note', userId: user.id, text: clean, at: new Date().toISOString() });
}

async function addShortage(db, { docId, text, user }) {
  const clean = requireText(text, 'اكتب وصف النقص.');
  return db.transaction(async (tx) => {
    if (!(await documentExists(tx, docId))) throw new WorkflowError('not_found', 'المستند غير موجود.');
    const id = await addEvent(tx, { documentId: docId, type: 'shortage', userId: user.id, text: clean, at: new Date().toISOString() });
    await tx.prepare('UPDATE documents SET has_open_shortage = 1 WHERE id = ?').run(docId);
    return id;
  });
}

/** إقفال نقص مفتوح مع وصف الحل */
async function closeShortage(db, { docId, shortageEventId, resolution, user }) {
  const text = requireText(resolution, 'اكتب كيف انحل النقص.');
  return db.transaction(async (tx) => {
    const shortage = await tx.prepare("SELECT id FROM document_events WHERE id = ? AND document_id = ? AND type = 'shortage'").get(Number(shortageEventId) || 0, docId);
    if (!shortage) throw new WorkflowError('not_found', 'النقص غير موجود.');
    if (await tx.prepare("SELECT 1 AS x FROM document_events WHERE ref_event_id = ? AND type = 'shortage_closed'").get(shortage.id)) {
      throw new WorkflowError('already_closed', 'هذا النقص مقفول من قبل.');
    }
    await addEvent(tx, { documentId: docId, type: 'shortage_closed', userId: user.id, text, refEventId: shortage.id, at: new Date().toISOString() });
    const open = (await tx.prepare(`
      SELECT COUNT(*) AS n FROM document_events s
      WHERE s.document_id = ? AND s.type = 'shortage'
        AND NOT EXISTS (SELECT 1 FROM document_events c WHERE c.ref_event_id = s.id AND c.type = 'shortage_closed')
    `).get(docId)).n;
    await tx.prepare('UPDATE documents SET has_open_shortage = ? WHERE id = ?').run(open > 0 ? 1 : 0, docId);
    return { openLeft: open };
  });
}

/** نواقص المستند (المفتوحة والمقفولة مع حلّها) */
async function listShortages(db, docId) {
  return db.prepare(`
    SELECT s.id, s.text, s.created_at, u.full_name AS user_name,
           c.id AS closed_event_id, c.text AS resolution, c.created_at AS closed_at, cu.full_name AS closed_by
    FROM document_events s
    LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN document_events c ON c.ref_event_id = s.id AND c.type = 'shortage_closed'
    LEFT JOIN users cu ON cu.id = c.user_id
    WHERE s.document_id = ? AND s.type = 'shortage'
    ORDER BY s.id ASC
  `).all(docId);
}

module.exports = {
  NEXT_STEP,
  PREVIOUS_STATUS,
  STATUS_LABELS,
  WorkflowError,
  advance,
  handOver,
  correctBack,
  addNote,
  addShortage,
  closeShortage,
  listShortages
};
