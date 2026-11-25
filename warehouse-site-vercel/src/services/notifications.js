/**
 * رسائل العميل في واتساب (المرحلة 3).
 *
 *  - كل تغيير حالة يجهّز رسالة لقروب العميل (إذا الحدث مفعّل من الإعدادات وللفسح رقم عميل).
 *  - الموقع ما يرسل شيء بنفسه: برنامج الإرسال (على جهاز الشركة) يسحب الرسائل المنتظرة ويرسلها ثم يرد بالنتيجة.
 *  - رسائل العميل ما يكون فيها أي اسم (لا موظف ولا موصل): الخانات المسموحة فقط {رقم_المستند} {اسم_العميل} {التاريخ}،
 *    والنص يُرفض إذا فيه اسم أي مستخدم أو موظف أو موصل مسجّل.
 *  - لو تراكمت أكثر من رسالة لنفس الطلب تُرسل الأحدث فقط، والرسالة الأقدم من المدة المحددة تنلغي.
 *  - نفس الرسالة (نفس الحدث لنفس الطلب) ما تتكرر للعميل حتى لو تصحّحت الحالة ورجعت.
 */
const { getSetting, setSetting } = require('../db');
const { formatRiyadh, startOfRiyadhDayIso } = require('./time');

const EVENTS = ['received', 'preparing', 'prepared', 'handed_to_courier'];
const EVENT_LABELS = {
  received: 'وصل الطلب للمستودع',
  preparing: 'بدأ تجهيز الطلب',
  prepared: 'انتهى تجهيز الطلب',
  handed_to_courier: 'تم شحن الطلب (سُلّم للموصل)'
};
const STATE_LABELS = {
  pending: 'بانتظار الإرسال',
  sent: 'أُرسلت',
  failed: 'ما أُرسلت',
  skipped: 'أُلغيت',
  expired: 'انتهت مدتها'
};
const ACK_RESULTS = new Set(['sent', 'failed', 'skipped', 'expired']);
const PLACEHOLDERS = ['رقم_الفاتورة', 'رقم_المستند', 'اسم_العميل', 'التاريخ'];

// الافتراضي: رسالتين فقط ("قيد التجهيز" و"تم الشحن")، وفيها رقم الفاتورة (أمر البيع من الفسح — اللي يعرفه العميل)
const DEFAULT_CONFIG = {
  max_age_minutes: 60,
  events: {
    received: { enabled: false, text: 'السلام عليكم، وصل طلبكم رقم {رقم_الفاتورة} للمستودع وبيبدأ تجهيزه قريباً.' },
    preparing: { enabled: true, text: 'السلام عليكم، طلبكم رقم {رقم_الفاتورة} قيد التجهيز في المستودع.' },
    prepared: { enabled: false, text: 'السلام عليكم، تم تجهيز طلبكم رقم {رقم_الفاتورة} وبيتم شحنه قريباً.' },
    handed_to_courier: { enabled: true, text: 'السلام عليكم، تم شحن طلبكم رقم {رقم_الفاتورة}. شكراً لتعاملكم معنا.' }
  }
};

const CONFIG_KEY = 'wa_messages';
const HEARTBEAT_KEY = 'program_heartbeat';
const PROGRAM_OFFLINE_AFTER_MS = 3 * 60 * 1000;

class TemplateError extends Error {}

// ---------- الإعدادات ----------

async function getConfig(db) {
  const saved = (await getSetting(db, CONFIG_KEY, {})) || {};
  const events = {};
  for (const ev of EVENTS) {
    const s = (saved.events && saved.events[ev]) || {};
    events[ev] = {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_CONFIG.events[ev].enabled,
      text: typeof s.text === 'string' && s.text.trim() ? s.text : DEFAULT_CONFIG.events[ev].text
    };
  }
  const age = Number(saved.max_age_minutes);
  return { max_age_minutes: Number.isInteger(age) && age >= 5 && age <= 1440 ? age : DEFAULT_CONFIG.max_age_minutes, events };
}

/** كلمات النص بعد التوحيد (بدون تشكيل ولا تطويل) */
function tokens(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(t => t.toLowerCase());
}

/** أول اسم (من القائمة) موجود في النص ككلمات كاملة، أو null */
function findName(text, names) {
  const t = tokens(text);
  for (const name of names) {
    const n = tokens(name);
    if (!n.length) continue;
    for (let i = 0; i + n.length <= t.length; i++) {
      if (n.every((w, j) => t[i + j] === w)) return name;
    }
  }
  return null;
}

/** أسماء الأشخاص المسجّلين (المستخدمون، الموظفون، الموصلون) — ممنوعة في رسائل العميل */
async function personNames(db) {
  const rows = [
    ...await db.prepare('SELECT full_name AS name FROM users').all(),
    ...await db.prepare('SELECT name FROM workers').all(),
    ...await db.prepare('SELECT name FROM couriers').all()
  ];
  return [...new Set(rows.map(r => String(r.name || '').trim()).filter(n => n.length >= 2))];
}

/** فحص نص رسالة: الخانات المسموحة فقط، وبدون أسماء أشخاص */
function validateTemplate(text, names) {
  const value = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!value) throw new TemplateError('نص الرسالة فاضي.');
  if (value.length > 500) throw new TemplateError('نص الرسالة طويل (الحد 500 حرف).');
  for (const m of value.matchAll(/\{([^{}]*)\}/g)) {
    if (!PLACEHOLDERS.includes(m[1].trim())) {
      throw new TemplateError(`الخانة {${m[1]}} غير مسموحة. المسموح فقط: {رقم_الفاتورة} {اسم_العميل} {التاريخ}`);
    }
  }
  if (/[{}]/.test(value.replace(/\{([^{}]*)\}/g, ''))) throw new TemplateError('في النص قوس { أو } زايد.');
  const name = findName(value, names);
  if (name) throw new TemplateError(`النص فيه اسم "${name}" — رسائل العميل ما يكون فيها أسماء موظفين أو موصلين.`);
  return value;
}

/**
 * حفظ الإعدادات بعد الفحص. input: {max_age_minutes, events: {ev: {enabled, text}}}
 * @throws {TemplateError} مع اسم الحدث في الرسالة
 */
async function saveConfig(db, input) {
  const names = await personNames(db);
  const age = Number(input.max_age_minutes);
  if (!Number.isInteger(age) || age < 5 || age > 1440) throw new TemplateError('مدة صلاحية الرسالة لازم تكون من 5 إلى 1440 دقيقة.');
  const events = {};
  for (const ev of EVENTS) {
    const e = (input.events && input.events[ev]) || {};
    try {
      events[ev] = { enabled: !!e.enabled, text: validateTemplate(e.text, names) };
    } catch (err) {
      if (err instanceof TemplateError) throw new TemplateError(`رسالة "${EVENT_LABELS[ev]}": ${err.message}`);
      throw err;
    }
  }
  const config = { max_age_minutes: age, events };
  await setSetting(db, CONFIG_KEY, config);
  return config;
}

/** نص الرسالة بعد تعبئة الخانات (والخانة الفاضية تنشال بدون ما تخرب الجملة) */
function render(template, doc, now = Date.now()) {
  const values = {
    // رقم الفاتورة = أمر البيع المكتوب في الفسح (الرقم اللي يعرفه العميل)
    'رقم_الفاتورة': (doc && doc.sales_order_no) || '',
    'رقم_المستند': (doc && (doc.sales_order_no || doc.doc_no)) || '',
    'اسم_العميل': (doc && doc.customer_name) || '',
    'التاريخ': formatRiyadh(new Date(now).toISOString()).split(' ')[0]
  };
  return String(template)
    // الرقم ما انقرأ: تنشال معه كلمة "رقم" اللي قبله ("طلبكم رقم {…} قيد التجهيز" => "طلبكم قيد التجهيز")
    .replace(/(?:رقم\s*)?\{\s*(رقم_الفاتورة|رقم_المستند)\s*\}/g, (all, key) => (values[key] ? all.replace(/\{[^{}]*\}/, values[key]) : ''))
    .replace(/\{([^{}]*)\}/g, (_, key) => values[key.trim()] ?? '')
    .split('\n')
    .map(line => line.replace(/[ \t]{2,}/g, ' ').replace(/ +([،.,!؟:])/g, '$1').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const EXAMPLE_DOC = { sales_order_no: '1911020', customer_name: 'مؤسسة النخبة' };

// ---------- تجهيز الرسائل (داخل نفس عملية تغيير الحالة) ----------

/**
 * رسالة للعميل عن حدث. ترجع رقم الرسالة أو null إذا ما تنرسل (الحدث موقوف، بدون رقم عميل، أو أُرسلت من قبل).
 */
async function enqueueForEvent(db, { docId, eventType, eventId = null, attachmentIds = [] }) {
  const cfg = await getConfig(db);
  const ev = cfg.events[eventType];
  const hasFiles = Array.isArray(attachmentIds) && attachmentIds.length > 0;
  // رسالة موقوفة من الإعدادات: ما تنرسل — إلا لو معها سند (السند يروح لحاله بدون نص)
  if (!ev || (!ev.enabled && !hasFiles)) return null;
  const doc = await db.prepare('SELECT id, customer_number, customer_name, doc_no, sales_order_no FROM documents WHERE id = ?').get(docId);
  if (!doc || !doc.customer_number) return null; // بدون رقم عميل ما نعرف قروبه
  // نفس الرسالة ما تتكرر للعميل (مثلاً بعد تصحيح الحالة ورجوعها)
  if (await db.prepare("SELECT 1 AS x FROM wa_notifications WHERE document_id = ? AND target = 'customer_group' AND event_type = ? AND state IN ('pending', 'sent')").get(docId, eventType)) {
    return null;
  }
  // رسالة أقدم لنفس الطلب ما انرسلت للحين: تنلغي، والأحدث هي اللي تروح
  await db.prepare("UPDATE wa_notifications SET state = 'skipped', last_error = ? WHERE document_id = ? AND target = 'customer_group' AND state = 'pending'")
    .run('انلغت لأن فيه رسالة أحدث لنفس الطلب', docId);
  const info = await db.prepare(`
    INSERT INTO wa_notifications (document_id, event_id, event_type, target, customer_number, text, state, attempts, created_at, attachment_ids)
    VALUES (?, ?, ?, 'customer_group', ?, ?, 'pending', 0, ?, ?)
  `).run(docId, eventId, eventType, doc.customer_number, ev.enabled ? render(ev.text, doc) : '', new Date().toISOString(), hasFiles ? JSON.stringify(attachmentIds) : null);
  return Number(info.lastInsertRowid);
}

/** إلغاء الرسائل اللي ما انرسلت لطلب (مثلاً بعد تصحيح الحالة) */
async function cancelPending(db, docId, reason) {
  return (await db.prepare("UPDATE wa_notifications SET state = 'skipped', last_error = ? WHERE document_id = ? AND state = 'pending'").run(reason, docId)).changes;
}

// ---------- واجهة البرنامج ----------

/** الرسائل المنتظرة للبرنامج (والأقدم من المدة المحددة تنلغي أولاً) */
async function listPendingForProgram(db, limit = 5, now = Date.now()) {
  const cfg = await getConfig(db);
  const cutoff = new Date(now - cfg.max_age_minutes * 60000).toISOString();
  await db.prepare("UPDATE wa_notifications SET state = 'expired', last_error = ? WHERE state = 'pending' AND created_at < ?")
    .run(`ما أُرسلت خلال ${cfg.max_age_minutes} دقيقة فانلغت`, cutoff);
  const pending = await db.prepare(`
    SELECT id, target, customer_number, text, created_at, attachment_ids FROM wa_notifications
    WHERE state = 'pending' ORDER BY id ASC LIMIT ?
  `).all(limit);
  const rows = [];
  for (const { attachment_ids: ids, ...r } of pending) {
    // المرفقات (سند التسليم): البرنامج يحمّلها من الموقع ويرسلها مع النص
    const list = parseIds(ids);
    if (!list.length) { rows.push(r); continue; }
    const atts = await db.prepare(`SELECT id, mime, size FROM document_attachments WHERE id IN (${list.map(() => '?').join(',')}) ORDER BY id`).all(...list);
    rows.push({ ...r, attachments: atts });
  }
  if (rows.length) {
    await db.prepare(`UPDATE wa_notifications SET attempts = attempts + 1 WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map(r => r.id));
  }
  return { max_age_minutes: cfg.max_age_minutes, notifications: rows };
}

function parseIds(value) {
  try { const a = JSON.parse(value || '[]'); return Array.isArray(a) ? a.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 10) : []; } catch (_) { return []; }
}

/** مرفق تابع لرسالة (عشان البرنامج ما يقدر يطلب أي ملف ثاني) */
async function attachmentForNotification(db, notificationId, attachmentId) {
  const n = await db.prepare('SELECT attachment_ids FROM wa_notifications WHERE id = ?').get(Number(notificationId) || 0);
  if (!n || !parseIds(n.attachment_ids).includes(Number(attachmentId))) return null;
  return (await db.prepare('SELECT * FROM document_attachments WHERE id = ?').get(Number(attachmentId))) || null;
}

/**
 * نتيجة الإرسال من البرنامج. تتسجّل مرة وحدة فقط (لو وصلت النتيجة مرتين، الثانية ما تغيّر شيء).
 * @returns {{status: number, body: object}}
 */
async function ack(db, id, result, reason) {
  if (!ACK_RESULTS.has(result)) return { status: 400, body: { ok: false, error: 'invalid_result' } };
  const row = await db.prepare('SELECT id, state FROM wa_notifications WHERE id = ?').get(id);
  if (!row) return { status: 404, body: { ok: false, error: 'not_found' } };
  if (row.state !== 'pending') return { status: 200, body: { ok: true, already: true, state: row.state } };
  const now = new Date().toISOString();
  await db.prepare("UPDATE wa_notifications SET state = ?, last_error = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END WHERE id = ? AND state = 'pending'")
    .run(result, reason || null, result, now, id);
  return { status: 200, body: { ok: true, state: result } };
}

/** نبضة البرنامج كل دقيقة: هل واتساب متصل، وكم فسح ينتظر الرفع عنده */
async function saveHeartbeat(db, { whatsapp, outboxPending, version }) {
  const prev = await getSetting(db, HEARTBEAT_KEY, null);
  const now = new Date().toISOString();
  const down = whatsapp !== 'connected';
  await setSetting(db, HEARTBEAT_KEY, {
    at: now,
    whatsapp: down ? 'down' : 'connected',
    wa_down_since: down ? ((prev && prev.whatsapp === 'down' && prev.wa_down_since) || now) : null,
    outbox_pending: Number.isInteger(outboxPending) && outboxPending >= 0 ? outboxPending : 0,
    version: version ? String(version).slice(0, 40) : null
  });
}

/**
 * حالة البرنامج للإدارة:
 *  never   = البرنامج ما تواصل أبداً
 *  offline = البرنامج ما تواصل من أكثر من 3 دقائق (الجهاز مطفي أو البرنامج مقفل أو ما فيه إنترنت)
 *  wa_down = البرنامج شغال لكن واتساب منقطع
 *  ok      = كل شيء تمام
 */
async function programStatus(db, now = Date.now()) {
  const hb = await getSetting(db, HEARTBEAT_KEY, null);
  if (!hb || !hb.at) return { state: 'never' };
  if (now - Date.parse(hb.at) > PROGRAM_OFFLINE_AFTER_MS) return { state: 'offline', since: hb.at, heartbeat: hb };
  if (hb.whatsapp !== 'connected') return { state: 'wa_down', since: hb.wa_down_since || hb.at, heartbeat: hb };
  return { state: 'ok', heartbeat: hb };
}

// ---------- للعرض ----------

async function stats(db, now = Date.now()) {
  const today = startOfRiyadhDayIso(now);
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM wa_notifications WHERE state = 'pending') AS pending,
      (SELECT COUNT(*) FROM wa_notifications WHERE state = 'sent' AND sent_at >= @today) AS sentToday,
      (SELECT COUNT(*) FROM wa_notifications WHERE state IN ('failed', 'expired') AND created_at >= @today) AS failedToday
  `).get({ today });
}

async function listRecent(db, limit = 30) {
  return db.prepare(`
    SELECT n.*, d.doc_no, d.doc_type, d.customer_name
    FROM wa_notifications n LEFT JOIN documents d ON d.id = n.document_id
    ORDER BY n.id DESC LIMIT ?
  `).all(limit);
}

async function listForDocument(db, docId) {
  return db.prepare('SELECT * FROM wa_notifications WHERE document_id = ? ORDER BY id ASC').all(docId);
}

module.exports = {
  attachmentForNotification,
  EVENTS,
  EVENT_LABELS,
  STATE_LABELS,
  PLACEHOLDERS,
  DEFAULT_CONFIG,
  EXAMPLE_DOC,
  TemplateError,
  getConfig,
  saveConfig,
  validateTemplate,
  personNames,
  findName,
  render,
  enqueueForEvent,
  cancelPending,
  listPendingForProgram,
  ack,
  saveHeartbeat,
  programStatus,
  stats,
  listRecent,
  listForDocument
};
