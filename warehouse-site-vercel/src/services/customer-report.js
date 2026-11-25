/**
 * تقارير الفواتير والعملاء (نسخة فيرسيل).
 *
 * البيانات في برنامج الواتساب على جهاز الشركة (قائمة العملاء + سجل كل مستند انرسل لعميل).
 * البرنامج يرسلها للموقع مع النبضة لما تتغير، والموقع يحسب التقرير لأي فترة — نفس حساب البرنامج بالضبط.
 * ما فيها أي أرقام جوالات: رقم العميل والمندوب واسم القروب بس.
 */
const storage = require('./storage');
const { getSetting, setSetting } = require('../db');

const SNAPSHOT_KEY = 'reports/customer-snapshot.json';
const META_KEY = 'customer_report_meta';
const TYPE_LABEL = { invoice: 'فاتورة', return: 'مرتجع', statement: 'كشف حساب', clearance: 'فسح' };
const TYPES = new Set(Object.keys(TYPE_LABEL));
const STATUSES = new Set(['sent', 'review', 'cash', 'stopped']);

const strip0 = (n) => String(n || '').replace(/^0+(?=\d)/, '');
const isCustomerNumber = (n) => /^\d{1,12}$/.test(String(n || '').trim());
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// اليوم والشهر بتوقيت الرياض (البرنامج يحسبها بتوقيت جهاز الشركة = الرياض)
const OFFSET_MS = 3 * 60 * 60 * 1000;
function riyadhDate(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t + OFFSET_MS).toISOString().slice(0, 10);
}

class ReportDataError extends Error {}

/** تنظيف البيانات الجاية من البرنامج (ما ينحفظ إلا الحقول المعروفة) */
function cleanSnapshot(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.customers) || !Array.isArray(input.records)) {
    throw new ReportDataError('بيانات التقرير غير صحيحة');
  }
  if (input.customers.length > 50000 || input.records.length > 200000) throw new ReportDataError('بيانات التقرير كبيرة جداً');
  const customers = input.customers
    .filter(c => c && isCustomerNumber(c.number))
    .map(c => ({ number: clean(c.number, 12), repCode: clean(c.repCode, 20), repName: clean(c.repName, 60) }));
  const records = input.records
    .filter(r => r && isCustomerNumber(r.customer) && TYPES.has(r.type) && !Number.isNaN(Date.parse(r.at)))
    .map(r => ({
      customer: clean(r.customer, 12),
      type: r.type,
      status: STATUSES.has(r.status) ? r.status : clean(r.status, 20),
      reason: clean(r.reason, 200),
      group: clean(r.group, 100),
      device: clean(r.device, 60),
      file: clean(r.file, 150),
      at: new Date(Date.parse(r.at)).toISOString(),
      sentAt: r.sentAt && !Number.isNaN(Date.parse(r.sentAt)) ? new Date(Date.parse(r.sentAt)).toISOString() : null
    }));
  const groups = {};
  if (input.groups && typeof input.groups === 'object') {
    for (const [k, v] of Object.entries(input.groups).slice(0, 60000)) {
      if (isCustomerNumber(k)) groups[strip0(k)] = clean(v, 100);
    }
  }
  const importedAt = input.importedAt && !Number.isNaN(Date.parse(input.importedAt)) ? new Date(Date.parse(input.importedAt)).toISOString() : null;
  return { importedAt, customers, records, groups, groupsLoaded: !!input.groupsLoaded };
}

async function saveSnapshot(db, input) {
  const snap = cleanSnapshot(input);
  await storage.replaceFile(db, SNAPSHOT_KEY, Buffer.from(JSON.stringify(snap), 'utf8'));
  await setSetting(db, META_KEY, { receivedAt: new Date().toISOString(), customers: snap.customers.length, records: snap.records.length });
  return { customers: snap.customers.length, records: snap.records.length };
}

async function loadSnapshot(db) {
  const buf = await storage.getFile(db, SNAPSHOT_KEY);
  if (!buf) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { return null; }
}

async function meta(db) {
  return getSetting(db, META_KEY, null);
}

/**
 * تقرير فترة (من تاريخ إلى تاريخ، شاملة اليومين) — نفس حساب البرنامج (customer-report.js).
 * الافتراضي: من أول الشهر الحالي إلى اليوم.
 */
function buildReport(snap, { from, to, month } = {}) {
  const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const today = riyadhDate(new Date().toISOString());
  if (!isDay(from) && /^\d{4}-\d{2}$/.test(String(month || ''))) { from = `${month}-01`; to = `${month}-31`; }
  if (!isDay(from)) from = `${today.slice(0, 7)}-01`;
  if (!isDay(to)) to = today;
  if (from > to) [from, to] = [to, from];
  const records = snap.records || [];
  const inRange = records.filter(r => { const d = riyadhDate(r.at); return d >= from && d <= to; });
  const byCustomer = new Map();
  for (const r of inRange) {
    const k = strip0(r.customer);
    if (!byCustomer.has(k)) byCustomer.set(k, []);
    byCustomer.get(k).push(r);
  }
  const groupOf = (n) => (snap.groupsLoaded ? !!(snap.groups || {})[strip0(n)] : null);
  const row = (number, repCode, repName, known) => {
    const recs = (byCustomer.get(strip0(number)) || []).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const count = (type, status) => recs.filter(r => r.type === type && (!status || r.status === status)).length;
    return {
      number, repCode, repName, known,
      invoices: count('invoice'),
      invoicesSent: count('invoice', 'sent'),
      returns: count('return'),
      statements: count('statement'),
      statementsSent: count('statement', 'sent'),
      clearances: count('clearance'),
      problems: recs.filter(r => r.status === 'review').length,
      cash: recs.filter(r => r.status === 'cash').length,
      lastAt: recs[0] ? recs[0].at : null,
      hasGroup: groupOf(number)
    };
  };
  const list = snap.customers || [];
  const known = list.map(c => row(c.number, c.repCode, c.repName, true));
  const knownSet = new Set(known.map(r => strip0(r.number)));
  const unknown = [...byCustomer.keys()].filter(k => !knownSet.has(k)).map(k => row(byCustomer.get(k)[0].customer, '', '', false));
  const reps = [...new Map(known.map(r => [`${r.repCode}|${r.repName}`, { code: r.repCode, name: r.repName }])).values()];
  return {
    from,
    to,
    importedAt: snap.importedAt,
    customersCount: known.length,
    reps,
    rows: [...known, ...unknown]
  };
}

/** كل مستندات عميل (كل الأشهر)، الأحدث أولاً، مع قروبه ومندوبه */
function customerHistory(snap, number) {
  const k = strip0(number);
  const info = (snap.customers || []).find(c => strip0(c.number) === k) || null;
  const group = snap.groupsLoaded ? ((snap.groups || {})[k] || null) : null;
  const history = (snap.records || []).filter(r => strip0(r.customer) === k)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .map(r => ({ ...r, typeLabel: TYPE_LABEL[r.type] || r.type }));
  return { number, info, group, history };
}

// ---------- رفع قائمة العملاء (PDF أو CSV من نظام المحاسبة) — بموافقة الإدارة ----------
// 1) الإدارة ترفع الملف => برنامج الواتساب يسحبه مع النبضة ويقرأه بس (parse) ويرجّع القائمة
// 2) الموقع يقارنها بالقائمة الحالية ويعرض التعديلات (جدد / انشالوا / تغيّر مندوبهم)
// 3) "موافق" => البرنامج يحفظ نفس القائمة اللي شافتها الإدارة (apply). "إلغاء" => ما يتغير شي

const IMPORT_KEY = 'customers_import';
const importFileKey = (id) => `imports/customers-${id}`;
const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
const newId = () => `${Date.now().toString(36)}${require('crypto').randomBytes(4).toString('hex')}`;

class ImportError extends Error {}

async function importState(db) {
  const s = (await getSetting(db, IMPORT_KEY, null)) || {};
  return { pending: s.pending || null, proposal: s.proposal || null, last: s.last || null };
}

async function saveState(db, s) {
  await setSetting(db, IMPORT_KEY, { pending: s.pending || null, proposal: s.proposal || null, last: s.last || null });
}

/** ملف جديد: البرنامج يقرأه (أي ملف أو اقتراح سابق ما انعتمد ينشال) */
async function queueImport(db, { buffer, name, userId }) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) throw new ImportError('اختر ملف قائمة العملاء (PDF أو CSV).');
  if (buffer.length > IMPORT_MAX_BYTES) throw new ImportError('حجم الملف كبير (الحد 4 ميقا).');
  const isPdf = buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  if (!isPdf && buffer.subarray(0, 4096).includes(0)) throw new ImportError('الملف لازم يكون PDF أو CSV.');
  const s = await importState(db);
  if (s.pending) await storage.deleteFile(db, importFileKey(s.pending.id));
  const id = newId();
  await storage.replaceFile(db, importFileKey(id), buffer);
  const pending = { id, mode: 'parse', name: clean(name, 120) || 'قائمة العملاء', at: new Date().toISOString(), userId: userId || null };
  await saveState(db, { pending, proposal: null, last: s.last });
  return pending;
}

async function importFile(db, id) {
  const s = await importState(db);
  if (!s.pending || s.pending.id !== id) return null;
  return storage.getFile(db, importFileKey(id));
}

function cleanList(list) {
  const seen = new Map();
  for (const c of Array.isArray(list) ? list.slice(0, 50000) : []) {
    if (!c || !isCustomerNumber(c.number)) continue;
    seen.set(strip0(c.number), { number: clean(c.number, 12), repCode: clean(c.repCode, 20), repName: clean(c.repName, 60) });
  }
  return [...seen.values()];
}

/** نتيجة البرنامج: قراءة الملف (قائمة للمراجعة) أو حفظ القائمة بعد الموافقة */
async function recordImportResult(db, id, body) {
  const s = await importState(db);
  if (!s.pending || s.pending.id !== id) return false;
  const r = body || {};
  const at = new Date().toISOString();
  await storage.deleteFile(db, importFileKey(id));
  if (s.pending.mode === 'apply') {
    s.last = r.ok
      ? { ok: true, name: s.pending.name, count: Number.isInteger(r.count) ? r.count : null, at }
      : { ok: false, name: s.pending.name, message: clean(r.message, 300) || 'تعذر تحديث القائمة', at };
  } else {
    const customers = r.ok ? cleanList(r.customers) : [];
    if (customers.length) s.proposal = { id, name: s.pending.name, customers, at };
    else s.last = { ok: false, name: s.pending.name, message: clean(r.message, 300) || 'ما لقيت أرقام عملاء في الملف', at };
  }
  s.pending = null;
  await saveState(db, s);
  return true;
}

/** التعديلات بين القائمة الحالية والقائمة الجديدة */
function diffLists(current, next) {
  const cur = new Map((current || []).map(c => [strip0(c.number), c]));
  const nxt = new Map((next || []).map(c => [strip0(c.number), c]));
  const repOf = (c) => (c.repName || c.repCode || '');
  const added = [];
  const changed = [];
  let same = 0;
  for (const [k, c] of nxt) {
    const old = cur.get(k);
    if (!old) added.push(c);
    else if (repOf(old) !== repOf(c)) changed.push({ number: c.number, from: repOf(old), to: repOf(c) });
    else same++;
  }
  const removed = [...cur].filter(([k]) => !nxt.has(k)).map(([, c]) => c);
  const byNum = (a, b) => String(a.number).localeCompare(String(b.number), 'en', { numeric: true });
  return { added: added.sort(byNum), removed: removed.sort(byNum), changed: changed.sort(byNum), same, total: nxt.size, current: cur.size };
}

/** الاقتراح مع التعديلات (للعرض) */
async function proposalWithDiff(db) {
  const s = await importState(db);
  if (!s.proposal) return null;
  const snap = await loadSnapshot(db);
  return { ...s.proposal, diff: diffLists(snap ? snap.customers : [], s.proposal.customers) };
}

/** "موافق": البرنامج يحفظ نفس القائمة اللي شافتها الإدارة */
async function approveProposal(db, userId) {
  const s = await importState(db);
  if (!s.proposal) throw new ImportError('ما فيه قائمة تنتظر الموافقة.');
  if (s.pending) await storage.deleteFile(db, importFileKey(s.pending.id));
  const id = newId();
  await storage.replaceFile(db, importFileKey(id), Buffer.from(JSON.stringify({ customers: s.proposal.customers }), 'utf8'));
  const pending = { id, mode: 'apply', name: s.proposal.name, at: new Date().toISOString(), userId: userId || null };
  await saveState(db, { pending, proposal: null, last: s.last });
  return pending;
}

async function cancelProposal(db) {
  const s = await importState(db);
  if (!s.proposal) return false;
  await saveState(db, { pending: s.pending, proposal: null, last: s.last });
  return true;
}

module.exports = {
  ReportDataError, TYPE_LABEL, cleanSnapshot, saveSnapshot, loadSnapshot, meta, buildReport, customerHistory, riyadhDate,
  ImportError, importState, queueImport, importFile, recordImportResult, diffLists, proposalWithDiff, approveProposal, cancelProposal
};
