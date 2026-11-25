/**
 * site-relay-client.js  (أجهزة الفروع البعيدة — بدون واتساب)
 *
 * نفس عمل relay-client.js لكن عبر الإنترنت عن طريق موقع المستودع بدل الشبكة المحلية:
 *  - المستندات المطبوعة تنحفظ في مجلد الصادر وتنرفع للموقع.
 *  - الجهاز الرئيسي (جدة) يسحبها من الموقع ويرسلها من رقم الشركة، والنتيجة ترجع هنا.
 *  - الموقع مطفي أو النت مقطوع: المستندات تنتظر وتنرفع لحالها، ونفس الملف ما يتكرر (بصمة الملف).
 *
 * الواجهة مطابقة لـ RelayClient (isPaired, pair, connect, start, stop, unlinked, serverUrl, onReview)
 * حتى يستخدمها البرنامج بنفس الطريقة.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateSiteUrl } = require('./warehouse-sync');

class SiteRelayClient {
  constructor({ credsFile, outboxDir, siteUrl = '', deviceName = '', log = console, pollMs = 3000, fetchImpl = null, requestTimeoutMs = 60000 }) {
    this.credsFile = credsFile;
    this.outboxDir = outboxDir;
    // مجلد مستقل عن طريقة الشبكة المحلية: لو تغيّرت طريقة الربط، ما يُعاد رفع مستند انرفع بالطريقة الثانية
    this.sentDir = path.join(outboxDir, 'تم_الرفع_للموقع');
    this.deviceName = deviceName;
    this.log = log;
    this.pollMs = pollMs;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.creds = null;
    this.serverUrl = null;
    this.unlinked = false;
    this.pending = new Map(); // jobId => {fileName, localPath}
    this.timer = null;
    this.busy = false;
    this.stopped = true;
    this.tickPromise = null;
    this.lastOfflineLog = 0;
    try {
      const c = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
      if (c && c.mode === 'site') this.creds = c;
    } catch (_) {}
    this.siteUrl = (this.creds && this.creds.siteUrl) || siteUrl;
  }

  isPaired() { return !!(this.creds && this.creds.mode === 'site' && this.creds.token && this.creds.deviceId); }
  get branch() { return this.creds ? this.creds.branch : null; }

  async request(method, pathname, { body = null, form = null, auth = true } = {}) {
    const doFetch = this.fetchImpl || globalThis.fetch;
    const headers = {};
    if (auth && this.creds) { headers.authorization = `Bearer ${this.creds.token}`; headers['x-device-id'] = String(this.creds.deviceId); }
    if (body) headers['content-type'] = 'application/json';
    const res = await doFetch(`${this.siteUrl}/api/relay${pathname}`, {
      method,
      headers,
      body: form || (body ? JSON.stringify(body) : undefined),
      redirect: 'error',
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  }

  /** الربط برمز من صفحة "أجهزة الفروع" في الموقع */
  async pair(code, siteUrl) {
    const v = validateSiteUrl(siteUrl || this.siteUrl);
    if (!v.ok) return { ok: false, reason: 'bad_url', message: v.reason };
    this.siteUrl = v.url;
    let r;
    try {
      r = await this.request('POST', '/pair', { body: { code: String(code || ''), device_name: this.deviceName }, auth: false });
    } catch (_) {
      return { ok: false, reason: 'not_found' };
    }
    if (r.status === 403) return { ok: false, reason: 'wrong_code' };
    if (r.status === 429) return { ok: false, reason: 'too_many_attempts' };
    if (r.status !== 200 || !r.json || !r.json.token) return { ok: false, reason: 'not_found' };
    this.creds = { mode: 'site', siteUrl: this.siteUrl, deviceId: r.json.device_id, token: r.json.token, branch: r.json.branch, name: r.json.name };
    fs.writeFileSync(this.credsFile, JSON.stringify(this.creds, null, 2), 'utf8');
    this.unlinked = false;
    this.serverUrl = this.siteUrl;
    return { ok: true, serverName: `موقع المستودع — فرع ${r.json.branch}`, branch: r.json.branch };
  }

  /**
   * التسجيل التلقائي من ملف تركيب الطابعة (فيه عنوان الموقع ومفتاح الفرع) — بدون أي رمز.
   * @returns {{ok: true, branch} | {ok: false, reason: 'bad_url'|'wrong_key'|'stopped'|'too_many_attempts'|'not_found'}}
   */
  async enroll(installKey, siteUrl, installId = '') {
    const v = validateSiteUrl(siteUrl || this.siteUrl);
    if (!v.ok) return { ok: false, reason: 'bad_url', message: v.reason };
    this.siteUrl = v.url;
    let r;
    try {
      // لو الجهاز مسجّل من قبل: يرسل مفتاحه الحالي عشان الموقع يعرف إنه نفس الجهاز (ينتقل فرعه بدل سجل جديد)
      const prev = this.creds && this.creds.mode === 'site' && this.creds.siteUrl === v.url && this.creds.deviceId && this.creds.token ? { device_id: this.creds.deviceId, token: this.creds.token } : {};
      r = await this.request('POST', '/enroll', { body: { install_key: String(installKey || ''), device_name: this.deviceName, ...prev }, auth: false });
    } catch (_) {
      return { ok: false, reason: 'not_found' };
    }
    if (r.status === 403) return { ok: false, reason: r.json && r.json.error === 'stopped' ? 'stopped' : 'wrong_key' };
    if (r.status === 429) return { ok: false, reason: 'too_many_attempts' };
    if (r.status !== 200 || !r.json || !r.json.token) return { ok: false, reason: 'not_found' };
    this.creds = { mode: 'site', siteUrl: this.siteUrl, deviceId: r.json.device_id, token: r.json.token, branch: r.json.branch, name: r.json.name, installId };
    fs.writeFileSync(this.credsFile, JSON.stringify(this.creds, null, 2), 'utf8');
    this.unlinked = false;
    this.serverUrl = this.siteUrl;
    return { ok: true, branch: r.json.branch };
  }

  /** التأكد إن الموقع متاح والربط شغال */
  async connect() {
    if (!this.isPaired()) return null;
    try {
      const r = await this.request('GET', '/hello');
      if (r.status === 200) {
        this.serverUrl = this.siteUrl;
        this.unlinked = false;
        return this.serverUrl;
      }
      if (r.status === 401) {
        if (!this.unlinked) this.log.error('❌ الموقع رفض هذا الجهاز (موقوف من صفحة "أجهزة المحاسبين")، أو انركّب من جديد على جهاز ثاني بنفس الاسم.');
        this.unlinked = true;
      }
    } catch (_) {}
    this.serverUrl = null;
    return null;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    fs.mkdirSync(this.outboxDir, { recursive: true });
    const tick = async () => {
      if (this.busy || this.stopped) return;
      this.busy = true;
      this.tickPromise = (async () => {
        try { await this.processOutbox(); await this.checkPending(); } catch (_) {}
      })();
      try { await this.tickPromise; } finally { this.busy = false; this.tickPromise = null; }
    };
    this.timer = setInterval(tick, this.pollMs);
    tick();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    if (this.tickPromise) { try { await this.tickPromise; } catch (_) {} }
  }

  pdfsIn(dir) {
    try {
      return fs.readdirSync(dir)
        .filter(f => f.toLowerCase().endsWith('.pdf'))
        .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t)
        .map(x => x.f);
    } catch (_) { return []; }
  }

  async upload(fullPath, fileName) {
    const buf = fs.readFileSync(fullPath);
    const form = new FormData();
    form.append('meta', JSON.stringify({ file_name: fileName, sha256: crypto.createHash('sha256').update(buf).digest('hex') }));
    form.append('pdf', new Blob([buf], { type: 'application/pdf' }), 'document.pdf');
    return this.request('POST', '/upload', { form });
  }

  async processOutbox() {
    if (!this.isPaired() || this.unlinked) return;
    const fresh = this.pdfsIn(this.outboxDir);
    // ملفات انرفعت قبل وما وصلت نتيجتها (مثلاً انقفل البرنامج): نرفعها مرة ثانية (الموقع يعرفها ويرجع نفس المهمة)
    const resumed = this.pdfsIn(this.sentDir).filter(f => ![...this.pending.values()].some(p => p.localPath === path.join(this.sentDir, f)));
    if (fresh.length === 0 && resumed.length === 0) return;
    if (!(await this.connect())) {
      if (Date.now() - this.lastOfflineLog > 60000) {
        this.lastOfflineLog = Date.now();
        this.log.warn(`⏳ موقع المستودع غير متاح حالياً (أو ما فيه إنترنت). يوجد (${fresh.length + resumed.length}) مستند بانتظار الإرسال وسيُرسل تلقائياً.`);
      }
      return;
    }
    for (const f of resumed) {
      if (this.stopped) return;
      const localPath = path.join(this.sentDir, f);
      const r = await this.upload(localPath, f.replace(/^\d{13}_/, ''));
      if ((r.status === 200 || r.status === 201) && r.json) this.pending.set(r.json.job_id, { fileName: f, localPath });
      else if (r.status === 401) { this.unlinked = true; return; }
    }
    for (const fileName of fresh) {
      if (this.stopped) return;
      const full = path.join(this.outboxDir, fileName);
      let r;
      try { r = await this.upload(full, fileName); } catch (_) { this.serverUrl = null; return; }
      if ((r.status === 200 || r.status === 201) && r.json) {
        fs.mkdirSync(this.sentDir, { recursive: true });
        let localPath = path.join(this.sentDir, fileName);
        if (fs.existsSync(localPath)) localPath = path.join(this.sentDir, `${Date.now()}_${fileName}`);
        fs.renameSync(full, localPath);
        this.pending.set(r.json.job_id, { fileName, localPath });
        this.log.log(`📤 تم رفع (${fileName}) لموقع المستودع${r.json.duplicate ? ' (كان مرفوعاً مسبقاً)' : ''}، بانتظار الإرسال من الجهاز الرئيسي...`);
      } else if (r.status === 422) {
        try { fs.unlinkSync(full); } catch (_) {}
        this.log.warn(`⚠ الموقع رفض الملف (${fileName}) لأنه ليس PDF، وتم حذفه.`);
      } else if (r.status === 401) {
        if (!this.unlinked) this.log.error('❌ الموقع رفض هذا الجهاز (موقوف من صفحة "أجهزة المحاسبين")، أو انركّب من جديد على جهاز ثاني بنفس الاسم.');
        this.unlinked = true;
        return;
      } else {
        this.log.warn(`⚠ تعذر رفع (${fileName}) (رمز ${r.status})، سيُعاد المحاولة.`);
        return;
      }
    }
  }

  async checkPending() {
    if (this.pending.size === 0 || !this.isPaired() || this.unlinked) return;
    for (const [jobId, info] of this.pending) {
      if (this.stopped) return;
      let r;
      try { r = await this.request('GET', `/jobs/${jobId}`); } catch (_) { return; }
      if (r.status === 404) { this.pending.delete(jobId); continue; }
      if (r.status !== 200 || !r.json || r.json.status !== 'done' || !r.json.outcome) continue;
      const o = r.json.outcome;
      if (o.status === 'sent') {
        this.log.log(`✅ (${info.fileName}): انرسل للعميل [${o.customer_number || '-'}] ← ${o.destination || ''}`);
      } else if (o.status === 'review') {
        this.log.warn(`⚠ (${info.fileName}): لم يُرسل ونُقل للمراجعة في الجهاز الرئيسي — ${o.message || ''}`);
        if (typeof this.onReview === 'function') { try { this.onReview(info.fileName, o.message || ''); } catch (_) {} }
      } else if (o.status === 'skipped') {
        this.log.log(`⏸ (${info.fileName}): ${o.message || 'لم يُرسل (موقوف من الإعدادات)'}`);
      } else {
        this.log.log(`🧪 (${info.fileName}): تشغيل تجريبي — ${o.message || ''}`);
      }
      // النتيجة النهائية وصلت: المستند الآن عند الجهاز الرئيسي => حذف نسخة هذا الجهاز
      try { if (fs.existsSync(info.localPath)) fs.unlinkSync(info.localPath); } catch (_) {}
      this.pending.delete(jobId);
    }
  }
}

module.exports = { SiteRelayClient };
