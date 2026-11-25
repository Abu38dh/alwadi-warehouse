/**
 * تقارير الإدارة: كم فسح وصل وتجهّز وانسلّم في فترة، وكم أخذ وقت، ومين جهّز ومين استلم، والنواقص.
 *
 *  - الفترة بأيام الرياض (UTC+3 بدون توقيت صيفي): من بداية "من" إلى نهاية "إلى".
 *  - كل رقم يُحسب بوقت حدثه: "وصل" بوقت الوصول، "تجهّز" بوقت انتهاء التجهيز، "انسلّم" بوقت التسليم.
 *  - فلتر الفرع اختياري (بدون = كل الفروع).
 */
const docs = require('./documents');

const OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 366;

const PERIODS = [
  { key: 'today', label: 'اليوم' },
  { key: 'yesterday', label: 'أمس' },
  { key: 'week', label: 'آخر 7 أيام' },
  { key: 'month', label: 'هذا الشهر' },
  { key: 'last_month', label: 'الشهر الماضي' }
];

class ReportError extends Error {}

/** "2026-11-18" (يوم الرياض) => أرقام اليوم */
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t; // منتصف الليل UTC لنفس التاريخ (بدون الإزاحة)
}

const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
/** يوم الرياض لوقت (UTC ms) */
const riyadhDayOf = (ms) => dayStr(ms + OFFSET_MS);
/** بداية يوم الرياض (منتصف الليل UTC للتاريخ) => وقت حقيقي ISO */
const startIso = (dayUtcMidnight) => new Date(dayUtcMidnight - OFFSET_MS).toISOString();

/**
 * الفترة المطلوبة من الرابط.
 * @returns {{key, label, fromDay, toDay, from, to, days}}  from شامل، to غير شامل (ISO)
 */
function resolvePeriod(query = {}, now = Date.now()) {
  const todayMid = parseDay(riyadhDayOf(now));
  let key = String(query.period || '').trim();
  let fromMid;
  let toMid;
  if (query.from || query.to) key = 'custom';
  switch (key) {
    case 'yesterday': fromMid = toMid = todayMid - DAY_MS; break;
    case 'week': fromMid = todayMid - 6 * DAY_MS; toMid = todayMid; break;
    case 'month': {
      const d = new Date(todayMid);
      fromMid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); toMid = todayMid; break;
    }
    case 'last_month': {
      const d = new Date(todayMid);
      fromMid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
      toMid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0); break;
    }
    case 'custom': {
      fromMid = parseDay(query.from);
      toMid = parseDay(query.to || query.from);
      if (fromMid == null || toMid == null) throw new ReportError('اختر تاريخ صحيح للفترة.');
      if (fromMid > toMid) [fromMid, toMid] = [toMid, fromMid];
      if (toMid > todayMid) toMid = todayMid;
      if (fromMid > todayMid) throw new ReportError('الفترة كلها في المستقبل.');
      if ((toMid - fromMid) / DAY_MS + 1 > MAX_DAYS) throw new ReportError('الفترة طويلة — اختر سنة أو أقل.');
      break;
    }
    default: key = 'today'; fromMid = toMid = todayMid;
  }
  const preset = PERIODS.find(p => p.key === key);
  const fromDay = dayStr(fromMid);
  const toDay = dayStr(toMid);
  return {
    key,
    label: preset ? preset.label : (fromDay === toDay ? fromDay : `${fromDay} إلى ${toDay}`),
    fromDay,
    toDay,
    from: startIso(fromMid),
    to: startIso(toMid + DAY_MS),
    days: Math.round((toMid - fromMid) / DAY_MS) + 1
  };
}

const minutesBetween = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 60000 : null);
const avg = (xs) => { const v = xs.filter(x => x != null && Number.isFinite(x) && x >= 0); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const inRange = (iso, p) => !!iso && iso >= p.from && iso < p.to;

/** كل فسح له حدث داخل الفترة (وصل أو بدأ أو تجهّز أو انسلّم) */
async function loadDocs(db, p, branch) {
  const b = docs.branchWhere(branch);
  return (await db.prepare(`
    SELECT d.id, d.doc_no, d.doc_type, d.customer_number, d.customer_name, d.status, d.branch,
           d.received_at, d.prep_started_at, d.prepared_at, d.handed_over_at, d.has_open_shortage, d.items_count, d.items_qty,
           w.name AS worker_name, w.branch AS worker_branch, c.name AS courier_name
    FROM documents d
    LEFT JOIN workers w ON w.id = d.preparer_worker_id
    LEFT JOIN couriers c ON c.id = d.courier_id
    WHERE ((d.received_at >= @from AND d.received_at < @to)
        OR (d.prep_started_at >= @from AND d.prep_started_at < @to)
        OR (d.prepared_at >= @from AND d.prepared_at < @to)
        OR (d.handed_over_at >= @from AND d.handed_over_at < @to))${b.sql.replace('?', '@branch')}
    ORDER BY d.received_at ASC, d.id ASC
  `).all({ from: p.from, to: p.to, ...(branch ? { branch } : {}) })).map(d => ({
    ...d,
    title: docs.docTitle(d),
    waitMinutes: minutesBetween(d.received_at, d.prep_started_at),
    prepMinutes: minutesBetween(d.prep_started_at, d.prepared_at),
    totalMinutes: minutesBetween(d.received_at, d.handed_over_at)
  }));
}

async function countEvents(db, p, branch, type) {
  const b = docs.branchWhere(branch);
  return (await db.prepare(`
    SELECT COUNT(*) AS n FROM document_events e JOIN documents d ON d.id = e.document_id
    WHERE e.type = ? AND e.created_at >= ? AND e.created_at < ?${b.sql}
  `).get(type, p.from, p.to, ...b.params)).n;
}

async function shortagesIn(db, p, branch) {
  const b = docs.branchWhere(branch);
  return (await db.prepare(`
    SELECT s.id, s.text, s.created_at, u.full_name AS user_name,
           d.id AS doc_id, d.doc_no, d.doc_type, d.customer_name, d.customer_number, d.branch,
           c.text AS resolution, c.created_at AS closed_at
    FROM document_events s
    JOIN documents d ON d.id = s.document_id
    LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN document_events c ON c.ref_event_id = s.id AND c.type = 'shortage_closed'
    WHERE s.type = 'shortage' AND s.created_at >= ? AND s.created_at < ?${b.sql}
    ORDER BY s.id ASC
  `).all(p.from, p.to, ...b.params)).map(s => ({ ...s, docTitle: docs.docTitle({ id: s.doc_id, doc_no: s.doc_no, doc_type: s.doc_type }) }));
}

async function messagesIn(db, p, branch) {
  const b = docs.branchWhere(branch);
  return db.prepare(`
    SELECT
      SUM(n.state = 'sent') AS sent,
      SUM(n.state IN ('failed', 'expired')) AS failed,
      SUM(n.state = 'skipped') AS skipped
    FROM wa_notifications n JOIN documents d ON d.id = n.document_id
    WHERE n.created_at >= ? AND n.created_at < ?${b.sql}
  `).get(p.from, p.to, ...b.params);
}

/** تجميع حسب مفتاح: عدد + متوسط */
function groupBy(items, keyFn, valueFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k == null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(valueFn ? valueFn(it) : null);
  }
  return map;
}

/**
 * @param {object} db
 * @param {ReturnType<typeof resolvePeriod>} p
 * @param {string|null} branch
 */
async function buildReport(db, p, branch = null) {
  const all = await loadDocs(db, p, branch);
  const received = all.filter(d => inRange(d.received_at, p));
  const started = all.filter(d => inRange(d.prep_started_at, p));
  const prepared = all.filter(d => inRange(d.prepared_at, p));
  const handed = all.filter(d => inRange(d.handed_over_at, p));
  const shortages = await shortagesIn(db, p, branch);
  const msg = (await messagesIn(db, p, branch)) || {};

  const summary = {
    received: received.length,
    prepared: prepared.length,
    handed: handed.length,
    avgWait: avg(started.map(d => d.waitMinutes)),
    avgPrep: avg(prepared.map(d => d.prepMinutes)),
    avgTotal: avg(handed.map(d => d.totalMinutes)),
    shortagesOpened: shortages.length,
    shortagesClosed: await countEvents(db, p, branch, 'shortage_closed'),
    corrections: await countEvents(db, p, branch, 'correction'),
    missingData: received.filter(d => !d.customer_number).length,
    messagesSent: msg.sent || 0,
    messagesFailed: msg.failed || 0
  };

  // حسب اليوم (أو الشهر لو الفترة أطول من شهرين)
  const byMonth = p.days > 62;
  const bucketOf = (iso) => { const day = riyadhDayOf(Date.parse(iso)); return byMonth ? day.slice(0, 7) : day; };
  const buckets = [];
  {
    const seen = new Set();
    for (let t = parseDay(p.fromDay); t <= parseDay(p.toDay); t += DAY_MS) {
      const k = byMonth ? dayStr(t).slice(0, 7) : dayStr(t);
      if (!seen.has(k)) { seen.add(k); buckets.push(k); }
    }
  }
  const countBy = (list, field) => { const m = new Map(); for (const d of list) { const k = bucketOf(d[field]); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const rc = countBy(received, 'received_at');
  const pc = countBy(prepared, 'prepared_at');
  const hc = countBy(handed, 'handed_over_at');
  const series = buckets.map(k => ({ key: k, received: rc.get(k) || 0, prepared: pc.get(k) || 0, handed: hc.get(k) || 0 }));

  // حسب الفرع (لما ما فيه فلتر فرع)
  let branches = [];
  if (!branch) {
    const names = [...new Set([...await docs.knownBranches(db), ...all.map(d => d.branch).filter(Boolean)])];
    branches = names.map(name => {
      const mine = (list) => list.filter(d => d.branch === name);
      return {
        name,
        received: mine(received).length,
        prepared: mine(prepared).length,
        handed: mine(handed).length,
        avgPrep: avg(mine(prepared).map(d => d.prepMinutes)),
        avgTotal: avg(mine(handed).map(d => d.totalMinutes)),
        shortages: shortages.filter(s => s.branch === name).length
      };
    }).filter(b => b.received || b.prepared || b.handed || b.shortages);
  }

  // الموظفون: كم فسح، وكم صنف وكم قطعة جهّزوا (من جدول الأصناف في الفسح)، ومتوسط وقتهم
  const wk = groupBy(prepared, d => (d.worker_name ? `${d.worker_name}\u0000${d.branch || ''}` : null), d => d);
  const workers = [...wk.entries()].map(([k, list]) => {
    const [name, br] = k.split('\u0000');
    const items = list.reduce((s, d) => s + (Number(d.items_count) || 0), 0);
    const qty = list.reduce((s, d) => s + (Number(d.items_qty) || 0), 0);
    return { name, branch: br || null, count: list.length, items, qty: Math.round(qty * 100) / 100, avgPrep: avg(list.map(d => d.prepMinutes)) };
  }).sort((a, b) => b.items - a.items || b.count - a.count || a.name.localeCompare(b.name, 'ar'));

  // الموصلون: كم استلموا
  const ck = groupBy(handed, d => (d.courier_name ? `${d.courier_name}\u0000${d.branch || ''}` : null));
  const couriers = [...ck.entries()].map(([k, list]) => {
    const [name, br] = k.split('\u0000');
    return { name, branch: br || null, count: list.length };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar'));

  // أكثر العملاء فسوحات
  const cust = groupBy(received, d => d.customer_number || null, d => d.customer_name);
  const customers = [...cust.entries()].map(([number, names]) => ({ number, name: names.find(Boolean) || '', count: names.length }))
    .sort((a, b) => b.count - a.count || a.number.localeCompare(b.number)).slice(0, 10);


  return { period: p, branch, summary, series, byMonth, branches, workers, couriers, customers, shortages, documents: all };
}

const fmtMin = (m) => (m == null ? '' : Math.round(m));

/** صفوف ملف Excel: فسح لكل صف (كل فسح وصل في الفترة) */
function excelRows(report, statusLabels, formatRiyadh) {
  const headers = ['الفسح', 'الفرع', 'رقم العميل', 'اسم العميل', 'الحالة الحالية', 'وصل', 'بدأ التجهيز', 'تم التجهيز', 'سُلّم للموصل',
    'الموظف', 'الموصل', 'الأصناف', 'القطع', 'انتظر قبل التجهيز (دقيقة)', 'مدة التجهيز (دقيقة)', 'من الوصول للتسليم (دقيقة)', 'نقص مفتوح'];
  const rows = report.documents.filter(d => inRange(d.received_at, report.period)).map(d => [
    d.title, d.branch || '', d.customer_number || '', d.customer_name || '', statusLabels[d.status] || d.status,
    formatRiyadh(d.received_at), formatRiyadh(d.prep_started_at), formatRiyadh(d.prepared_at), formatRiyadh(d.handed_over_at),
    d.worker_name || '', d.courier_name || '', d.items_count || '', d.items_qty || '', fmtMin(d.waitMinutes), fmtMin(d.prepMinutes), fmtMin(d.totalMinutes), d.has_open_shortage ? 'نعم' : ''
  ]);
  return { headers, rows, widths: [14, 10, 12, 26, 14, 17, 17, 17, 17, 14, 14, 9, 9, 14, 14, 16, 10] };
}

module.exports = { PERIODS, ReportError, resolvePeriod, buildReport, excelRows, riyadhDayOf };
