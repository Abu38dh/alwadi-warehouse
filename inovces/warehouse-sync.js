/**
 * warehouse-sync.js  (الجهاز الرئيسي فقط)
 *
 * رفع الفسوحات إلى موقع المستودع:
 *  - queueForWarehouse: ينسخ الـ PDF وبياناته إلى مجلد انتظار محلي (warehouse-outbox) — سريع ولا يتصل بالشبكة.
 *  - عامل خلفي يرفع ما في المجلد للموقع، ويعيد المحاولة بمهلة متزايدة (10ث ← 30ث ← 1د ← 2د ← 5د).
 *  - لا يُحذف أي ملف من المجلد إلا بعد أن يرد الموقع بالاستلام. إعادة الرفع آمنة (الموقع يعرف المكرر من بصمة الملف).
 *  - البرنامج هو الذي يتصل بالموقع دائماً. تعطل الموقع لا يؤثر على إرسال واتساب إطلاقاً.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKOFF_STEPS_MS = [10000, 30000, 60000, 120000, 300000];
const MAX_REMEMBERED = 3000;
// ردود من الموقع معناها "هذا الملف مرفوض ولن يُقبل مهما أعدنا" => يُنقل لمجلد rejected (لا يُحذف)
const PERMANENT_REJECT_STATUSES = new Set([400, 413, 415, 422]);

function sha256OfBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * رابط الموقع: https فقط (حتى لا يمر مفتاح الربط مكشوفاً)، ويُسمح بـ http لنفس الجهاز للتجربة.
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
function validateSiteUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return { ok: false, reason: 'رابط موقع المستودع غير محدد' };
  let u;
  try { u = new URL(s); } catch (_) { return { ok: false, reason: 'رابط موقع المستودع غير صحيح (مثال: https://warehouse.example.com)' }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    return { ok: false, reason: 'رابط موقع المستودع لازم يبدأ بـ https://' };
  }
  if (u.username || u.password || u.search || u.hash) return { ok: false, reason: 'رابط موقع المستودع غير صحيح' };
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

class WarehouseSync {
  /**
   * @param {object} o
   * @param {string} o.outboxDir   مجلد الانتظار
   * @param {() => {siteUrl: string, apiKey: string}} o.getConfig  يُقرأ عند كل محاولة (الإعدادات قد تتغير والبرنامج شغال)
   * @param {(status: object) => void} [o.onChange]  يُستدعى عند تغيّر العدد أو الحالة (لتحديث الواجهة)
   */
  constructor({ outboxDir, getConfig, log = console, fetchImpl = null, backoffStepsMs = BACKOFF_STEPS_MS, requestTimeoutMs = 30000, onChange = null }) {
    this.outboxDir = outboxDir;
    this.rejectedDir = path.join(outboxDir, 'rejected');
    this.stateFile = path.join(outboxDir, 'state.json');
    this.getConfig = getConfig;
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.backoffStepsMs = backoffStepsMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onChange = onChange;
    this.timer = null;
    this.busy = false;
    this.again = false;
    this.stopped = true;
    this.failures = 0;
    this.lastError = null;
    this.lastOkAt = null;
    this.nextRetryAt = null;
    this.tickPromise = null;
    this.state = null;
  }

  // ---------- الحالة المحفوظة: بصمات الملفات التي استلمها الموقع (حتى لا يُعاد رفعها) ----------

  loadState() {
    if (this.state) return this.state;
    try { this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (_) { this.state = null; }
    if (!this.state || typeof this.state.uploaded !== 'object' || !this.state.uploaded) this.state = { uploaded: {} };
    return this.state;
  }

  saveState() {
    const keys = Object.keys(this.state.uploaded);
    if (keys.length > MAX_REMEMBERED) {
      keys.sort((a, b) => String(this.state.uploaded[a]).localeCompare(String(this.state.uploaded[b])));
      for (const k of keys.slice(0, keys.length - MAX_REMEMBERED)) delete this.state.uploaded[k];
    }
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
    fs.renameSync(tmp, this.stateFile);
  }

  wasUploaded(sha) { return !!this.loadState().uploaded[sha]; }

  // ---------- الإعدادات ----------

  config() {
    let c = {};
    try { c = this.getConfig() || {}; } catch (_) {}
    const apiKey = String(c.apiKey || '').trim();
    if (!String(c.siteUrl || '').trim() && !apiKey) return { ok: false, configured: false, reason: 'الربط مع موقع المستودع غير مفعّل' };
    const v = validateSiteUrl(c.siteUrl);
    if (!v.ok) return { ok: false, configured: false, reason: v.reason };
    if (!apiKey) return { ok: false, configured: false, reason: 'مفتاح الربط مع موقع المستودع غير محدد' };
    return { ok: true, configured: true, url: v.url, apiKey };
  }

  isConfigured() { return this.config().ok; }

  // ---------- مجلد الانتظار ----------

  /**
   * وضع مستند في مجلد الانتظار (نسخة من الـ PDF + ملف بياناته). لا يتصل بالشبكة.
   * آمن عند التكرار: نفس الملف (نفس البصمة) لا يُضاف مرتين ولا يُعاد رفعه بعد استلام الموقع له.
   * @returns {{queued: boolean, already?: boolean, sha256: string}}
   */
  queueForWarehouse(pdfPath, meta = {}) {
    const buf = fs.readFileSync(pdfPath);
    const sha = sha256OfBuffer(buf);
    if (this.wasUploaded(sha)) return { queued: false, already: true, sha256: sha };
    fs.mkdirSync(this.outboxDir, { recursive: true });
    const pdfTarget = path.join(this.outboxDir, `${sha}.pdf`);
    const jsonTarget = path.join(this.outboxDir, `${sha}.json`);
    if (fs.existsSync(jsonTarget) && fs.existsSync(pdfTarget)) return { queued: false, already: true, sha256: sha };

    // الـ PDF أولاً ثم ملف البيانات (وجود ملف البيانات = المستند جاهز للرفع)، وكلاهما بكتابة مؤقتة ثم استبدال
    const pdfTmp = `${pdfTarget}.tmp`;
    fs.writeFileSync(pdfTmp, buf);
    fs.renameSync(pdfTmp, pdfTarget);
    const record = { ...meta, sha256: sha, size: buf.length, file_name: meta.file_name || path.basename(pdfPath), queued_at: new Date().toISOString() };
    const jsonTmp = `${jsonTarget}.tmp`;
    fs.writeFileSync(jsonTmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(jsonTmp, jsonTarget);

    this.changed();
    this.kick();
    return { queued: true, sha256: sha };
  }

  listPending() {
    let names = [];
    try { names = fs.readdirSync(this.outboxDir); } catch (_) { return []; }
    const out = [];
    for (const n of names) {
      const m = /^([0-9a-f]{64})\.json$/.exec(n);
      if (!m) continue;
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(path.join(this.outboxDir, n)).mtimeMs; } catch (_) { continue; }
      out.push({ sha: m[1], jsonPath: path.join(this.outboxDir, n), pdfPath: path.join(this.outboxDir, `${m[1]}.pdf`), mtimeMs });
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  pendingCount() { return this.listPending().length; }

  rejectedCount() {
    try { return fs.readdirSync(this.rejectedDir).filter(n => /\.pdf$/i.test(n)).length; } catch (_) { return 0; }
  }

  status() {
    const cfg = this.config();
    return {
      configured: cfg.ok,
      configProblem: cfg.ok ? null : cfg.reason,
      pending: this.pendingCount(),
      rejected: this.rejectedCount(),
      lastError: this.lastError,
      lastOkAt: this.lastOkAt,
      nextRetryAt: this.nextRetryAt
    };
  }

  changed() {
    if (!this.onChange) return;
    try { this.onChange(this.status()); } catch (_) {}
  }

  // ---------- العامل الخلفي ----------

  start() {
    this.stopped = false;
    this.kick();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRetryAt = null;
    if (this.tickPromise) { try { await this.tickPromise; } catch (_) {} }
  }

  /** محاولة فورية (مستند جديد، أو تغيّرت الإعدادات) */
  kick() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRetryAt = null;
    this.tick().catch(() => {});
  }

  scheduleRetry() {
    if (this.stopped) return;
    const step = this.backoffStepsMs[Math.min(this.failures, this.backoffStepsMs.length) - 1] || this.backoffStepsMs[0];
    clearTimeout(this.timer);
    this.nextRetryAt = new Date(Date.now() + step).toISOString();
    this.timer = setTimeout(() => { this.timer = null; this.nextRetryAt = null; this.tick().catch(() => {}); }, step);
    if (this.timer.unref) this.timer.unref();
  }

  tick() {
    if (this.busy) { this.again = true; return this.tickPromise; }
    this.busy = true;
    this.tickPromise = this.runTick().finally(() => {
      this.busy = false;
      this.tickPromise = null;
      if (this.again) { this.again = false; if (!this.stopped && !this.timer) this.tick().catch(() => {}); }
    });
    return this.tickPromise;
  }

  async runTick() {
    const items = this.listPending();
    if (items.length === 0) { this.failures = 0; return; }
    const cfg = this.config();
    if (!cfg.ok) {
      // الإعدادات ناقصة: المستندات تبقى في المجلد، وتُرفع عند حفظ الإعدادات (kick)
      if (this.lastError !== cfg.reason) { this.lastError = cfg.reason; this.changed(); }
      return;
    }
    for (const item of items) {
      if (this.stopped) return;
      const r = await this.uploadOne(cfg, item);
      if (r.result === 'retry') {
        this.failures++;
        if (this.lastError !== r.reason) this.log.warn(`⚠ موقع المستودع: تعذر الرفع (${r.reason}) — المستندات تنتظر وستُرفع تلقائياً.`);
        this.lastError = r.reason;
        this.scheduleRetry();
        this.changed();
        return;
      }
      this.changed();
    }
    this.failures = 0;
  }

  /** @returns {Promise<{result: 'ok'|'rejected'|'retry', reason?: string}>} */
  async uploadOne(cfg, item) {
    let meta;
    let pdf;
    try {
      meta = JSON.parse(fs.readFileSync(item.jsonPath, 'utf8'));
      pdf = fs.readFileSync(item.pdfPath);
    } catch (err) {
      this.reject(item, `ملف الانتظار تالف أو ناقص: ${err.message}`);
      return { result: 'rejected' };
    }

    const doFetch = this.fetchImpl || globalThis.fetch;
    let res;
    let body = null;
    try {
      const form = new FormData();
      form.append('meta', JSON.stringify(meta));
      form.append('pdf', new Blob([pdf], { type: 'application/pdf' }), `${item.sha}.pdf`);
      res = await doFetch(`${cfg.url}/api/integration/documents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}` },
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
      try { body = await res.json(); } catch (_) {}
    } catch (err) {
      const cause = err && err.cause && err.cause.code ? ` ${err.cause.code}` : '';
      return { result: 'retry', reason: `الموقع لا يرد${cause || `: ${err && err.message ? err.message : err}`}` };
    }

    // الاستلام المؤكد فقط: الموقع رد بنجاح وذكر نفس بصمة الملف
    if ((res.status === 200 || res.status === 201) && body && body.ok === true && body.sha256 === item.sha) {
      this.loadState().uploaded[item.sha] = new Date().toISOString();
      try { this.saveState(); } catch (_) {}
      try { fs.unlinkSync(item.jsonPath); } catch (_) {}
      try { fs.unlinkSync(item.pdfPath); } catch (_) {}
      this.lastError = null;
      this.lastOkAt = new Date().toISOString();
      this.log.log(`🏬 موقع المستودع: ${body.duplicate ? 'المستند موجود مسبقاً' : 'تم استلام الفسح'} (${meta.file_name || item.sha.slice(0, 12)}).`);
      return { result: 'ok' };
    }
    if (res.status === 401 || res.status === 403) {
      return { result: 'retry', reason: 'الموقع رفض مفتاح الربط — تأكد من المفتاح في الإعدادات' };
    }
    if (PERMANENT_REJECT_STATUSES.has(res.status)) {
      this.reject(item, `الموقع رفض الملف (${res.status}): ${(body && (body.message || body.error)) || 'بدون تفاصيل'}`);
      return { result: 'rejected' };
    }
    return { result: 'retry', reason: `رد غير متوقع من الموقع (${res.status})` };
  }

  /** ملف لن يقبله الموقع: يُنقل إلى rejected مع السبب (لا يُحذف) حتى لا يعطّل ما بعده */
  reject(item, reason) {
    try {
      fs.mkdirSync(this.rejectedDir, { recursive: true });
      for (const p of [item.pdfPath, item.jsonPath]) {
        if (fs.existsSync(p)) fs.renameSync(p, path.join(this.rejectedDir, path.basename(p)));
      }
      fs.writeFileSync(path.join(this.rejectedDir, `${item.sha}.reason.txt`), `${new Date().toISOString()}\n${reason}\n`, 'utf8');
    } catch (_) {}
    this.log.warn(`⚠ موقع المستودع: ${reason} — نُقل الملف إلى warehouse-outbox/rejected`);
  }
}

module.exports = { WarehouseSync, validateSiteUrl, sha256OfBuffer, BACKOFF_STEPS_MS };
