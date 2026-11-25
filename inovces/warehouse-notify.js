/**
 * warehouse-notify.js  (الجهاز الرئيسي فقط)
 *
 * رسائل العميل من موقع المستودع (المرحلة 3):
 *  - كل 10 ثواني يسأل الموقع عن رسائل تنتظر الإرسال (فقط إذا واتساب متصل وما فيه رسائل منتظرة عندنا).
 *  - الرسائل تدخل طابور البرنامج نفسه (نفس المهلة بين الرسائل، والمستندات لها الأولوية) — الإرسال الفعلي في index.js.
 *  - بعد الإرسال يرد على الموقع بالنتيجة (sent / failed / skipped / expired).
 *  - ما تتكرر رسالة: رقم كل رسالة انرسلت ينحفظ في ملف قبل ما نبلّغ الموقع، فلو انقطع الاتصال
 *    ورجع الموقع يعرضها، نبلّغه إنها انرسلت بدون ما نرسلها مرة ثانية. والنتيجة اللي ما وصلت للموقع تنعاد لاحقاً.
 *  - وقبل ما تطلع أي رسالة لواتساب ينحفظ رقمها ("بدأ إرسالها"): لو الموقع عرضها مرة ثانية وهي للحين
 *    تنتظر تأكيد واتساب نتجاهلها، ولو ما وصل تأكيد أو طفى البرنامج في نصها ما تنعاد أبداً
 *    (تنسجّل "ما أُرسلت" مع السبب) — تكرار الرسالة عند العميل أسوأ من رسالة ناقصة.
 *  - كل دقيقة نبضة للموقع: هل واتساب متصل + كم فسح ينتظر الرفع.
 *  - البرنامج هو اللي يتصل دائماً. تعطل الموقع ما يأثر على إرسال المستندات.
 */

const fs = require('fs');
const path = require('path');
const { validateSiteUrl } = require('./warehouse-sync');

const MAX_REMEMBERED = 3000;
const ATTEMPTED_REASON = 'بدأ إرسالها قبل وما تأكد وصولها — ما تنعاد عشان ما تتكرر عند العميل';

class WarehouseNotifier {
  /**
   * @param {object} o
   * @param {string} o.stateFile   ملف حفظ أرقام الرسائل المرسلة والنتائج اللي ما وصلت للموقع
   * @param {() => {siteUrl: string, apiKey: string}} o.getConfig
   * @param {() => boolean} o.isWhatsAppReady
   * @param {() => boolean} o.hasQueuedMessages  هل فيه رسائل في طابور البرنامج للحين
   * @param {(n: object) => void} o.enqueueMessage  يضيف رسالة لطابور البرنامج
   * @param {() => number} [o.getOutboxPending]
   * @param {() => object|null} [o.getReportSnapshot]  بيانات تقرير العملاء (قائمة العملاء + سجل المستندات) — تنرسل للموقع لما تتغير
   */
  constructor({ stateFile, getConfig, isWhatsAppReady, hasQueuedMessages, enqueueMessage, getOutboxPending = () => 0, getReportSnapshot = null, onCustomersImport = null, getEngineState = null, runCommand = null, onRelayHint = null, syncMs = 10000, log = console, fetchImpl = null, pollMs = 10000, heartbeatMs = 60000, requestTimeoutMs = 15000, version = '' }) {
    // صفحات "واتساب والإرسال" في الموقع على الإنترنت: البرنامج يرسل حالته، وياخذ أوامر الإدارة وينفذها
    this.getEngineState = getEngineState;
    this.runCommand = runCommand;
    this.syncMs = syncMs;
    this.syncTimer = null;
    this.syncing = false;
    this.lastStateHash = null;
    this.lastStateAt = 0;
    this.syncPausedUntil = 0;
    this.pendingResults = [];
    this.doneCommands = new Set();
    // تلميحات الموقع (مع كل مزامنة): هل فيه رسائل عملاء أو مستندات فروع تنتظر؟ — عشان ما نسأل كل 10 ثواني على الفاضي
    this.hints = null;
    this.lastForcedPoll = {};
    this.onRelayHint = onRelayHint;
    this.getReportSnapshot = getReportSnapshot;
    this.onCustomersImport = onCustomersImport;
    this.importResults = new Map(); // ملفات قائمة العملاء اللي انقرت (لو ما وصلت النتيجة للموقع ما نقرأها مرة ثانية)
    this.lastReportHash = null;
    this.lastReportAt = 0;
    this.reportPausedUntil = 0;
    this.stateFile = stateFile;
    this.getConfig = getConfig;
    this.isWhatsAppReady = isWhatsAppReady;
    this.hasQueuedMessages = hasQueuedMessages;
    this.enqueueMessage = enqueueMessage;
    this.getOutboxPending = getOutboxPending;
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.pollMs = pollMs;
    this.heartbeatMs = heartbeatMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.version = version;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.polling = false;
    this.stopped = true;
    this.lastError = null;
    this.lastPollAt = null;
    this.lastHeartbeatAt = null;
    this.state = null;
    this.inFlight = new Set(); // رسائل طلعت لواتساب وتنتظر النتيجة الحين
  }

  // ---------- الحالة المحفوظة ----------

  loadState() {
    if (this.state) return this.state;
    try { this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (_) { this.state = null; }
    if (!this.state || typeof this.state !== 'object') this.state = {};
    if (!this.state.sent || typeof this.state.sent !== 'object') this.state.sent = {};
    if (!Array.isArray(this.state.pendingAcks)) this.state.pendingAcks = [];
    if (!this.state.attempted || typeof this.state.attempted !== 'object') this.state.attempted = {};
    this.syncSite();
    return this.state;
  }

  /**
   * أرقام الرسائل المحفوظة تخص موقع واحد. لو تغيّر عنوان الموقع (مثلاً من الموقع المحلي إلى موقع على الإنترنت)
   * الأرقام هناك تبدأ من 1 من جديد — بدون مسح الذاكرة، الرسائل الجديدة تنحسب "أُرسلت من قبل" وما تطلع للعميل.
   */
  syncSite() {
    if (this.syncingSite) return;
    const cfg = this.config();
    if (!cfg.ok) return;
    const s = this.state;
    if (s.site === cfg.url) return;
    if (s.site) {
      s.sent = {};
      s.attempted = {};
      s.pendingAcks = [];
      this.inFlight.clear();
      try { this.log.warn(`⚠ تغيّر عنوان موقع المستودع (${s.site} ← ${cfg.url}): انمسحت ذاكرة الرسائل المرسلة للموقع القديم.`); } catch (_) {}
    }
    s.site = cfg.url;
    this.syncingSite = true;
    try { this.saveState(); } catch (_) {} finally { this.syncingSite = false; }
  }

  saveState() {
    const s = this.loadState();
    for (const map of [s.sent, s.attempted]) {
      const ids = Object.keys(map);
      if (ids.length > MAX_REMEMBERED) {
        ids.sort((a, b) => Number(a) - Number(b));
        for (const id of ids.slice(0, ids.length - MAX_REMEMBERED)) delete map[id];
      }
    }
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
    fs.renameSync(tmp, this.stateFile);
  }

  wasSent(id) { return !!this.loadState().sent[String(id)]; }

  /** بدأ إرسالها لواتساب قبل (حتى لو ما وصل تأكيد)؟ */
  wasAttempted(id) { return !!this.loadState().attempted[String(id)]; }

  /** قبل ما تطلع الرسالة لواتساب مباشرة: ينحفظ رقمها في الملف (لو ما انحفظ => ما نرسل) */
  markAttempt(id) {
    const s = this.loadState();
    s.attempted[String(id)] = new Date().toISOString();
    this.saveState();
    this.inFlight.add(String(id));
  }

  /** ما طلع شيء فعلاً (واتساب كان مقطوع قبل الإرسال): نرجعها كأنها ما بدت */
  clearAttempt(id) {
    const s = this.loadState();
    delete s.attempted[String(id)];
    this.inFlight.delete(String(id));
    try { this.saveState(); } catch (_) {}
  }

  // ---------- الاتصال بالموقع ----------

  config() {
    let c = {};
    try { c = this.getConfig() || {}; } catch (_) {}
    const apiKey = String(c.apiKey || '').trim();
    const v = validateSiteUrl(c.siteUrl);
    if (!v.ok || !apiKey) return { ok: false };
    return { ok: true, url: v.url, apiKey };
  }

  async request(cfg, method, pathname, body) {
    const doFetch = this.fetchImpl || globalThis.fetch;
    const res = await doFetch(`${cfg.url}/api/integration${pathname}`, {
      method,
      headers: { authorization: `Bearer ${cfg.apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  }

  /**
   * تحميل مرفق رسالة (سند التسليم) من الموقع.
   * @returns {Promise<{ok: true, data: Buffer, mime: string} | {ok: false, gone?: boolean, reason: string}>}
   */
  async fetchAttachment(notificationId, att) {
    const cfg = this.config();
    if (!cfg.ok) return { ok: false, reason: 'الموقع غير مربوط' };
    const doFetch = this.fetchImpl || globalThis.fetch;
    try {
      const res = await doFetch(`${cfg.url}/api/integration/notifications/${notificationId}/attachments/${att.id}`, {
        headers: { authorization: `Bearer ${cfg.apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(this.requestTimeoutMs, 60000))
      });
      if (res.status === 404) return { ok: false, gone: true, reason: 'السند ما عاد موجود في الموقع' };
      if (res.status !== 200) return { ok: false, reason: `الموقع رد (${res.status}) على تحميل السند` };
      const data = Buffer.from(await res.arrayBuffer());
      if (!data.length || data.length > 16 * 1024 * 1024) return { ok: false, gone: true, reason: 'السند فاضي أو حجمه كبير' };
      return { ok: true, data, mime: String(att.mime || res.headers.get('content-type') || 'application/octet-stream') };
    } catch (err) {
      return { ok: false, reason: `تعذر تحميل السند: ${err.message}` };
    }
  }

  // ---------- النتائج ----------

  /**
   * تبليغ الموقع بنتيجة رسالة. "أُرسلت" تنحفظ في الملف قبل التبليغ (حتى ما تتكرر لو انقطع الاتصال).
   * لو التبليغ فشل، النتيجة تنحفظ وتنعاد مع السحب الجاي.
   */
  async ack(id, result, reason = '') {
    const s = this.loadState();
    this.inFlight.delete(String(id));
    if (result === 'sent') s.sent[String(id)] = new Date().toISOString();
    s.pendingAcks = s.pendingAcks.filter(a => a.id !== id);
    s.pendingAcks.push({ id, result, reason: String(reason || '').slice(0, 300) });
    try { this.saveState(); } catch (err) { this.log.warn(`⚠ تعذر حفظ حالة رسائل العملاء: ${err.message}`); }
    await this.flushAcks();
  }

  async flushAcks() {
    const cfg = this.config();
    if (!cfg.ok) return;
    const s = this.loadState();
    for (const a of [...s.pendingAcks]) {
      try {
        const r = await this.request(cfg, 'POST', `/notifications/${a.id}/ack`, { result: a.result, reason: a.reason });
        // 200 = تسجّلت، 404 = الرسالة ما عادت موجودة، 400 = طلب غلط: كلها ما ينفع نعيدها
        if (r.status === 200 || r.status === 404 || r.status === 400) {
          s.pendingAcks = s.pendingAcks.filter(x => x.id !== a.id);
        } else {
          this.lastError = `الموقع رد (${r.status}) على نتيجة رسالة`;
          break;
        }
      } catch (err) {
        this.lastError = `تعذر تبليغ الموقع بنتيجة رسالة: ${err.message}`;
        break;
      }
    }
    try { this.saveState(); } catch (_) {}
  }

  // ---------- السحب ----------

  /**
   * هل نسأل الموقع الحين؟ بدون تلميحات حديثة (موقع قديم أو المزامنة واقفة) => نسأل دائماً مثل قبل.
   * مع تلميحات: نسأل لما الموقع يقول فيه شي، ومرة كل دقيقتين احتياط.
   */
  shouldPoll(kind) {
    const h = this.hints;
    if (!h || Date.now() - h.at > 45000) return true;
    if (h[kind]) return true;
    const last = this.lastForcedPoll[kind] || 0;
    if (Date.now() - last > 120000) { this.lastForcedPoll[kind] = Date.now(); return true; }
    return false;
  }

  async poll() {
    if (this.polling) return;
    const cfg = this.config();
    if (!cfg.ok) return;
    this.polling = true;
    try {
      await this.flushAcks();
      // واتساب مقطوع أو عندنا رسائل ما خلصت: ما نسحب جديد (تبقى في الموقع، وتنلغي هناك لو طالت)
      if (!this.isWhatsAppReady() || this.hasQueuedMessages()) return;
      if (!this.shouldPoll('notifications')) return;
      const r = await this.request(cfg, 'GET', '/notifications?limit=5');
      if (r.status !== 200 || !r.json || !Array.isArray(r.json.notifications)) {
        this.lastError = r.status === 401 ? 'الموقع رفض مفتاح الربط' : `رد غير متوقع من الموقع (${r.status})`;
        return;
      }
      this.lastError = null;
      this.lastPollAt = new Date().toISOString();
      const maxAge = Number(r.json.max_age_minutes) || 60;
      for (const n of r.json.notifications) {
        if (!n || !Number.isInteger(n.id)) continue;
        if (this.wasSent(n.id)) {
          // انرسلت قبل وما وصل التبليغ للموقع: نبلّغه بدون إرسال
          await this.ack(n.id, 'sent', 'أُرسلت من قبل');
          continue;
        }
        // طالعة الحين وتنتظر تأكيد واتساب: نتركها، نتيجتها توصل الموقع بعد شوي
        if (this.inFlight.has(String(n.id))) continue;
        if (this.wasAttempted(n.id)) {
          // بدأ إرسالها قبل (طفى البرنامج في نصها): ما نعيدها عشان ما توصل العميل مرتين
          await this.ack(n.id, 'failed', ATTEMPTED_REASON);
          continue;
        }
        this.enqueueMessage({ ...n, max_age_minutes: maxAge });
      }
    } catch (err) {
      this.lastError = `الموقع لا يرد: ${err && err.cause && err.cause.code ? err.cause.code : (err && err.message) || err}`;
    } finally {
      this.polling = false;
    }
  }

  async heartbeat() {
    const cfg = this.config();
    if (!cfg.ok) return;
    try {
      const r = await this.request(cfg, 'POST', '/heartbeat', {
        whatsapp: this.isWhatsAppReady() ? 'connected' : 'down',
        outbox_pending: Number(this.getOutboxPending()) || 0,
        version: this.version
      });
      if (r.status === 200) {
        this.lastHeartbeatAt = new Date().toISOString();
        this.rememberBranches(r.json);
        if (r.json && r.json.customers_import) await this.importCustomers(cfg, r.json.customers_import);
        await this.pushReport(cfg);
      }
    } catch (_) { /* الموقع طافي: النبضة الجاية */ }
  }

  /**
   * مزامنة صفحات "واتساب والإرسال" في الموقع (كل 10 ثواني، طلب واحد):
   *  - نرسل حالة البرنامج (الاتصال، الباركود، السجل، النقدي، الإعدادات) بس لما تتغير (أو كل 5 دقائق)
   *  - ونرسل نتائج الأوامر اللي نفذناها
   *  - والرد فيه أوامر جديدة من الإدارة => ننفذها ونرجع على طول بالنتيجة والحالة الجديدة
   * موقع قديم ما يعرف الطلب (404) => نوقف نص ساعة.
   */
  async syncRemote() {
    if (!this.getEngineState || this.syncing || Date.now() < this.syncPausedUntil) return;
    const cfg = this.config();
    if (!cfg.ok) return;
    this.syncing = true;
    try {
      for (let round = 0; round < 4; round++) {
        let state = null;
        try { state = await this.getEngineState(); } catch (_) {}
        const hash = state ? require('crypto').createHash('sha256').update(JSON.stringify(state)).digest('hex') : null;
        const sendState = !!state && (hash !== this.lastStateHash || Date.now() - this.lastStateAt > 5 * 60 * 1000);
        const results = this.pendingResults.splice(0);
        let r;
        try {
          r = await this.request(cfg, 'POST', '/engine/sync', { results, ...(sendState ? { state } : {}) });
        } catch (_) { this.pendingResults.unshift(...results); return; }
        if (r.status === 404) { this.syncPausedUntil = Date.now() + 30 * 60 * 1000; return; }
        if (r.status !== 200) { this.pendingResults.unshift(...results); return; }
        if (sendState) { this.lastStateHash = hash; this.lastStateAt = Date.now(); }
        if (r.json && r.json.hints && typeof r.json.hints === 'object') {
          this.hints = { at: Date.now(), notifications: !!r.json.hints.notifications, relay: !!r.json.hints.relay };
          // فيه شي ينتظر: نسحبه على طول بدل ما ننتظر الدورة الجاية
          if (this.hints.notifications && !this.stopped) this.poll().catch(() => {});
          if (this.hints.relay && this.onRelayHint) { try { this.onRelayHint(); } catch (_) {} }
        }
        const commands = (r.json && Array.isArray(r.json.commands)) ? r.json.commands : [];
        if (!commands.length && !results.length) return;
        if (!commands.length) continue; // نرسل الحالة بعد آخر أمر
        for (const c of commands) {
          if (!c || !c.id || this.doneCommands.has(String(c.id))) continue;
          this.doneCommands.add(String(c.id));
          if (this.doneCommands.size > 500) this.doneCommands.delete(this.doneCommands.values().next().value);
          let result;
          try { result = this.runCommand ? await this.runCommand(c) : { status: 501, json: { success: false, message: 'غير مدعوم' } }; } catch (err) { result = { status: 500, json: { success: false, message: (err && err.message) || 'تعذر التنفيذ' } }; }
          this.pendingResults.push({ id: c.id, status: result.status || 200, json: result.json == null ? null : result.json });
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  /**
   * قائمة عملاء جديدة مرفوعة من الموقع (صفحة "تقارير الفواتير"): نحمّل الملف، البرنامج يقرأه ويحدّث القائمة،
   * ونرجّع النتيجة للموقع. نفس الملف ما ينقرأ مرتين (لو النتيجة ما وصلت نعيد إرسالها بس).
   */
  async importCustomers(cfg, job) {
    if (!this.onCustomersImport || !job || !job.id) return;
    const id = String(job.id).replace(/[^\w-]/g, '').slice(0, 64);
    if (!id) return;
    let result = this.importResults.get(id);
    if (!result) {
      const doFetch = this.fetchImpl || globalThis.fetch;
      let buf;
      try {
        const res = await doFetch(`${cfg.url}/api/integration/customers-import/${id}/file`, {
          headers: { authorization: `Bearer ${cfg.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(60000)
        });
        if (!res.ok) return;
        buf = Buffer.from(await res.arrayBuffer());
      } catch (_) { return; }
      try { result = await this.onCustomersImport(buf, { ...job, id }); } catch (err) { result = { ok: false, message: (err && err.message) || 'تعذر قراءة الملف' }; }
      this.importResults.set(id, result);
      if (this.importResults.size > 20) this.importResults.delete(this.importResults.keys().next().value);
    }
    try { await this.request(cfg, 'POST', `/customers-import/${id}/result`, result); } catch (_) { /* المرة الجاية */ }
  }

  /**
   * تقرير العملاء للموقع (صفحة "تقارير الفواتير" في الموقع على الإنترنت):
   * ينرسل بس لما تتغير البيانات (أو كل 30 دقيقة للتأكيد). موقع قديم ما يعرف الطلب (404) => نوقف نص ساعة.
   */
  async pushReport(cfg) {
    if (!this.getReportSnapshot || Date.now() < this.reportPausedUntil) return;
    let snap = null;
    try { snap = this.getReportSnapshot(); } catch (_) { return; }
    if (!snap) return;
    const hash = require('crypto').createHash('sha256').update(JSON.stringify(snap)).digest('hex');
    if (hash === this.lastReportHash && Date.now() - this.lastReportAt < 30 * 60 * 1000) return;
    try {
      const r = await this.request(cfg, 'POST', '/customer-report', snap);
      if (r.status === 200) { this.lastReportHash = hash; this.lastReportAt = Date.now(); }
      else if (r.status === 404) this.reportPausedUntil = Date.now() + 30 * 60 * 1000;
    } catch (_) { /* المرة الجاية */ }
  }

  /** أسماء الفروع من رد النبضة (تنحفظ عشان تظهر في الإعدادات حتى لو الموقع طافي) */
  rememberBranches(json) {
    if (!json || !Array.isArray(json.branches)) return;
    const clean = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40);
    const names = [...new Set(json.branches.map(clean).filter(Boolean))].slice(0, 50);
    const main = clean(json.main_branch) || names[0] || '';
    const s = this.loadState();
    if (JSON.stringify(s.branches) === JSON.stringify(names) && s.mainBranch === main) return;
    s.branches = names;
    s.mainBranch = main;
    try { this.saveState(); } catch (_) {}
  }

  /** @returns {{main: string, names: string[]}} */
  siteBranches() {
    const s = this.loadState();
    return { main: s.mainBranch || '', names: Array.isArray(s.branches) ? s.branches : [] };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.pollTimer = setInterval(() => { this.poll().catch(() => {}); }, this.pollMs);
    this.heartbeatTimer = setInterval(() => { this.heartbeat().catch(() => {}); }, this.heartbeatMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    if (this.getEngineState) {
      this.syncTimer = setInterval(() => { this.syncRemote().catch(() => {}); }, this.syncMs);
      if (this.syncTimer.unref) this.syncTimer.unref();
      this.syncRemote().catch(() => {});
    }
    this.heartbeat().catch(() => {});
    this.poll().catch(() => {});
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.pollTimer = null;
    this.heartbeatTimer = null;
  }

  status() {
    return { lastPollAt: this.lastPollAt, lastHeartbeatAt: this.lastHeartbeatAt, lastError: this.lastError, pendingAcks: this.loadState().pendingAcks.length };
  }
}

module.exports = { WarehouseNotifier, ATTEMPTED_REASON };
