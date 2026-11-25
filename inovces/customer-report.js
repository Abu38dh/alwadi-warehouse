/**
 * customer-report.js — سجل العملاء وتقاريرهم (في الجهاز الرئيسي فقط)
 *
 * - قائمة العملاء (رقم العميل + المندوب) تُستورد من ملف PDF أو CSV.
 * - كل مستند يُعالج لعميل يُسجَّل: نوعه (فاتورة/مرتجع/كشف حساب/فسح)، النتيجة (أُرسل/مراجعة/نقدي/موقوف)،
 *   التاريخ، القروب، والجهاز الذي طبعه.
 * - التقارير: لكل شهر — مين طلب فواتير ومين ما طلب، مين انرسل له كشف حساب ومين لا، حسب المندوب.
 *
 * لا تُحفظ أي أرقام جوالات.
 */

const fs = require('fs');
const path = require('path');

const TYPE_BY_SUBFOLDER = { 'فواتير': 'invoice', 'مرتجعات': 'return', 'كشوفات': 'statement', 'فسوحات': 'clearance' };
const TYPE_LABEL = { invoice: 'فاتورة', return: 'مرتجع', statement: 'كشف حساب', clearance: 'فسح' };

const strip0 = (n) => String(n || '').replace(/^0+(?=\d)/, '');
const isCustomerNumber = (n) => /^\d{1,12}$/.test(String(n || '').trim());

/**
 * كتابة آمنة: ملف مؤقت يُثبَّت على القرص (fsync) ثم يحل محل الأصلي،
 * والنسخة السابقة تُحفظ في .bak (لو انقطعت الكهرباء أو تلف الملف يرجع منها).
 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 1), null, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch (_) {}
  fs.renameSync(tmp, file);
}

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} };

/**
 * قراءة آمنة: { ok, data, missing }.
 *  - الملف غير موجود => ok (بداية جديدة).
 *  - مقفول لحظياً (برنامج حماية/نسخ احتياطي) => يعيد المحاولة.
 *  - تالف => يرجع للنسخة الاحتياطية .bak.
 *  - فشل كل شي => ok:false ولا يُكتب فوقه أبداً (حتى لا تضيع البيانات).
 */
function readJsonSafe(file, isValid) {
  for (const f of [file, `${file}.bak`]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (isValid(data)) return { ok: true, data, fromBackup: f !== file };
        break; // محتوى غير صالح => جرّب النسخة الاحتياطية
      } catch (e) {
        if (e.code === 'ENOENT') break;
        if (e instanceof SyntaxError) break;
        sleepSync(200); // مقفول لحظياً
      }
    }
  }
  const missing = !fs.existsSync(file) && !fs.existsSync(`${file}.bak`);
  return { ok: missing, data: null, missing };
}

// ==========================================
// استيراد قائمة العملاء
// ==========================================

/**
 * قراءة جدول العملاء من مواضع النص في ملف PDF (# | customer_no | rep_code | rep_name).
 * الأعمدة تُحدد من موضع عناوينها، والاسم العربي يُقرأ من اليمين لليسار حسب موضع كل حرف
 * (صحيح سواء كان الملف يحفظ الحروف منفردة أو كلمات كاملة).
 * @param {Array<{page,str,x,y,w,h}>} items
 * @param {(s: string) => string} normalize توحيد النص العربي
 */
function parseCustomerListFromItems(items, normalize = (s) => s) {
  const byPage = new Map();
  for (const it of items || []) {
    if (!byPage.has(it.page)) byPage.set(it.page, []);
    byPage.get(it.page).push(it);
  }
  let cols = null; // x لبداية كل عمود (من عناوين الجدول)
  const out = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const rows = [];
    for (const it of byPage.get(page).sort((a, b) => b.y - a.y)) {
      const row = rows.find(r => Math.abs(r.y - it.y) <= 0.45 * Math.max(r.h, it.h));
      if (row) { row.items.push(it); row.h = Math.max(row.h, it.h); } else rows.push({ y: it.y, h: it.h, items: [it] });
    }
    for (const row of rows) {
      const header = row.items.map(i => i.str).join(' ');
      if (/customer_no/i.test(header)) {
        const at = (re) => { const i = row.items.find(x => re.test(x.str)); return i ? i.x : null; };
        cols = { no: at(/customer_no/i), code: at(/rep_code/i), name: at(/rep_name/i) };
        continue;
      }
      if (!cols || cols.no == null) continue;
      const tol = 4;
      const inCol = (it, from, to) => it.x >= from - tol && (to == null || it.x < to - tol);
      const noItems = row.items.filter(it => inCol(it, cols.no, cols.code));
      const codeItems = cols.code == null ? [] : row.items.filter(it => inCol(it, cols.code, cols.name));
      const nameItems = cols.name == null ? [] : row.items.filter(it => inCol(it, cols.name, null));
      const number = noItems.sort((a, b) => a.x - b.x).map(i => i.str).join('').replace(/\s/g, '');
      if (!/^\d{1,12}$/.test(number)) continue;
      const repCode = codeItems.sort((a, b) => a.x - b.x).map(i => i.str).join('').replace(/\s/g, '');
      // الاسم: من اليمين لليسار، مع مسافة عند الفراغ بين الكلمات
      const sorted = nameItems.sort((a, b) => b.x - a.x);
      let repName = '';
      sorted.forEach((it, i) => {
        if (i > 0) {
          const prev = sorted[i - 1];
          const gap = prev.x - (it.x + it.w);
          if (gap > 0.2 * Math.max(prev.h, it.h)) repName += ' ';
        }
        repName += it.str;
      });
      out.push({ number, repCode: /^\d+$/.test(repCode) ? repCode : '', repName: normalize(repName).replace(/\s+/g, ' ').trim() });
    }
  }
  return out;
}

/**
 * CSV / Excel محفوظ CSV: لازم يكون فيه سطر عناوين فيه customer_no (أو "رقم العميل")،
 * والأعمدة تُؤخذ حسب العناوين (ما يعتمد على مكانها).
 */
function parseCustomerListFromCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  const split = (line) => line.split(/[,;\t]/).map(c => c.replace(/^"|"$/g, '').trim());
  const headerIdx = lines.findIndex(l => /customer_?no|رقم\s*العميل/i.test(l));
  if (headerIdx < 0) throw new Error('الملف لازم يكون فيه عمود customer_no (رقم العميل)');
  const head = split(lines[headerIdx]).map(h => h.toLowerCase());
  const col = (re) => head.findIndex(h => re.test(h));
  const cNo = col(/customer_?no|رقم\s*العميل/i);
  const cCode = col(/rep_?code|رقم\s*المندوب/i);
  const cName = head.findIndex((h, i) => i !== cCode && i !== cNo && /rep_?name|اسم\s*المندوب|^المندوب$/i.test(h));
  const out = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const cells = split(line);
    const number = cells[cNo] || '';
    if (!/^\d{1,12}$/.test(number)) continue;
    out.push({ number, repCode: cCode >= 0 && /^\d+$/.test(cells[cCode] || '') ? cells[cCode] : '', repName: cName >= 0 && cName !== cNo ? (cells[cName] || '') : '' });
  }
  return out;
}

// ==========================================
// المخزن
// ==========================================

class CustomerReport {
  constructor({ dataDir }) {
    this.customersFile = path.join(dataDir, 'customers-list.json');
    this.activityFile = path.join(dataDir, 'customer-activity.json');
    const c = readJsonSafe(this.customersFile, (d) => d && Array.isArray(d.customers));
    this.customers = c.data || { importedAt: null, source: '', customers: [] };
    this.customersWritable = c.ok;
    const a = readJsonSafe(this.activityFile, (d) => d && Array.isArray(d.records));
    this.activity = a.data || { records: [] };
    // السجل موجود لكن تعذرت قراءته (ولا النسخة الاحتياطية): لا يُكتب فوقه أبداً
    this.activityWritable = a.ok;
    this.loadError = (!a.ok ? 'تعذر قراءة سجل العملاء — لن يُكتب فوقه حتى لا يضيع (أعد تشغيل البرنامج)' : '') || (!c.ok ? 'تعذر قراءة قائمة العملاء' : '');
    if (a.fromBackup) console.warn('⚠ سجل العملاء كان تالفاً، تم استرجاعه من النسخة الاحتياطية.');
    if (this.loadError) console.error('❌ ' + this.loadError);
    this.index = new Map(this.activity.records.map((r, i) => [r.key || r.file, i]));
  }

  /** استبدال قائمة العملاء (السجل لا يتأثر) */
  importCustomers(list, source = '', { force = false } = {}) {
    const seen = new Map();
    for (const c of list || []) {
      if (!isCustomerNumber(c.number)) continue;
      seen.set(strip0(c.number), { number: String(c.number).trim(), repCode: String(c.repCode || '').trim(), repName: String(c.repName || '').trim() });
    }
    const current = (this.customers.customers || []).length;
    // القائمة الجديدة أصغر بكثير من الحالية => غالباً ملف غلط: يطلب تأكيد
    if (!force && current >= 20 && seen.size < current * 0.5) {
      const err = new Error(`الملف فيه ${seen.size} عميل فقط والقائمة الحالية ${current} عميل`);
      err.needsConfirm = true; err.count = seen.size; err.current = current;
      throw err;
    }
    const next = { importedAt: new Date().toISOString(), source, customers: [...seen.values()] };
    // نسخة من القائمة القديمة قبل الاستبدال
    try { if (fs.existsSync(this.customersFile)) fs.copyFileSync(this.customersFile, this.customersFile.replace(/\.json$/, `.before-${Date.now()}.json`)); } catch (_) {}
    writeJsonAtomic(this.customersFile, next); // يُكتب أولاً، ثم يُعتمد في الذاكرة
    this.customers = next;
    this.customersWritable = true;
    return next.customers.length;
  }

  /**
   * تسجيل نتيجة مستند لعميل (نفس الملف يُحدَّث بدل التكرار، مثلاً: مراجعة ثم أُرسل بعد إعادة الإرسال).
   * @param {{file, customerNumber, docSubfolder, status: 'sent'|'review'|'skipped', reason?, destination?, kind?}} e
   */
  record(e) {
    const customer = String(e.customerNumber || '').trim();
    if (!isCustomerNumber(customer) || !e.file) return false;
    if (!this.activityWritable) { console.error('❌ لم يُسجل المستند في التقارير: ' + this.loadError); return false; }
    // كل مستند له مفتاح خاص: الاسم + الحجم (ملف جديد بنفس الاسم لاحقاً = مستند جديد)
    const key = `${e.file}|${Number(e.size) || 0}`;
    const type = TYPE_BY_SUBFOLDER[e.docSubfolder] || 'invoice';
    const status = e.status === 'skipped' ? (e.kind === 'cash' ? 'cash' : 'stopped') : e.status;
    const now = new Date().toISOString();
    const device = String(e.file).includes('__') ? String(e.file).split('__')[0] : 'الجهاز الرئيسي';
    const i = this.index.has(key) ? this.index.get(key) : this.index.get(e.file);
    if (i != null && (this.activity.records[i].key ? this.activity.records[i].key === key : true)) {
      const r = this.activity.records[i];
      if (r.status === status && r.customer === customer) return false;
      Object.assign(r, { customer, type, status, reason: e.reason || '', group: groupName(e.destination) || r.group || '', updatedAt: now });
      if (status === 'sent' && !r.sentAt) r.sentAt = now;
    } else {
      const r = { key, file: e.file, customer, type, status, reason: e.reason || '', group: groupName(e.destination), device, at: now, ...(status === 'sent' ? { sentAt: now } : {}) };
      this.index.set(key, this.activity.records.length);
      this.activity.records.push(r);
    }
    try { writeJsonAtomic(this.activityFile, this.activity); } catch (err) { console.error('❌ تعذر حفظ سجل العملاء:', err.message); }
    return true;
  }

  months() {
    const set = new Set(this.activity.records.map(r => localMonth(r.at)).filter(Boolean));
    set.add(localMonth(new Date().toISOString()));
    return [...set].sort().reverse();
  }

  /**
   * تقرير فترة (من تاريخ إلى تاريخ، شاملة اليومين): لكل عميل في القائمة عدد مستنداته وحالتها،
   * ومن ليس في القائمة يظهر منفصلاً. الافتراضي: من أول الشهر الحالي إلى اليوم.
   * @param {{from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD', month?: 'YYYY-MM', hasGroup?: (n: string) => boolean}} o
   */
  report({ from, to, month, hasGroup } = {}) {
    const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
    const today = localDate(new Date().toISOString());
    if (!isDay(from) && /^\d{4}-\d{2}$/.test(String(month || ''))) { from = `${month}-01`; to = `${month}-31`; }
    if (!isDay(from)) from = `${today.slice(0, 7)}-01`;
    if (!isDay(to)) to = today;
    if (from > to) [from, to] = [to, from];
    const inMonth = this.activity.records.filter(r => { const d = localDate(r.at); return d >= from && d <= to; });
    month = from.slice(0, 7);
    const byCustomer = new Map();
    for (const r of inMonth) {
      const k = strip0(r.customer);
      if (!byCustomer.has(k)) byCustomer.set(k, []);
      byCustomer.get(k).push(r);
    }
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
        hasGroup: typeof hasGroup === 'function' ? !!hasGroup(number) : null
      };
    };
    const list = Array.isArray(this.customers && this.customers.customers) ? this.customers.customers : [];
    const known = list.map(c => row(c.number, c.repCode, c.repName, true));
    const knownSet = new Set(known.map(r => strip0(r.number)));
    const unknown = [...byCustomer.keys()].filter(k => !knownSet.has(k))
      .map(k => row(byCustomer.get(k)[0].customer, '', '', false));
    const all = [...known, ...unknown];
    const reps = [...new Map(known.map(r => [`${r.repCode}|${r.repName}`, { code: r.repCode, name: r.repName }])).values()];
    return {
      month,
      from,
      to,
      importedAt: this.customers.importedAt,
      customersCount: known.length,
      reps,
      summary: {
        ordered: known.filter(r => r.invoices > 0).length,
        notOrdered: known.filter(r => r.invoices === 0).length,
        statementSent: known.filter(r => r.statementsSent > 0).length,
        statementNotSent: known.filter(r => r.statementsSent === 0).length,
        documents: inMonth.length,
        sent: inMonth.filter(r => r.status === 'sent').length,
        problems: inMonth.filter(r => r.status === 'review').length,
        unknownCustomers: unknown.length
      },
      rows: all
    };
  }

  /** كل مستندات عميل (كل الأشهر)، الأحدث أولاً */
  history(number) {
    const k = strip0(number);
    return this.activity.records.filter(r => strip0(r.customer) === k)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .map(r => ({ ...r, typeLabel: TYPE_LABEL[r.type] || r.type }));
  }
}

function groupName(destination) {
  const s = String(destination || '');
  return s.startsWith('قروب: ') ? s.slice('قروب: '.length) : '';
}

/** اليوم (YYYY-MM-DD) حسب توقيت الجهاز */
function localDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** الشهر حسب توقيت الجهاز (وليس UTC) حتى لا يُحسب مستند آخر الليل على الشهر الخطأ */
function localMonth(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = { CustomerReport, parseCustomerListFromItems, parseCustomerListFromCsv, TYPE_LABEL, localMonth, localDate };
