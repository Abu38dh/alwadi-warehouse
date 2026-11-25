/**
 * site-relay-inbox.js  (الجهاز الرئيسي فقط — جدة)
 *
 * مستندات الفروع البعيدة: أجهزة الفروع ترفعها لموقع المستودع (لأن الجهاز الرئيسي بدون IP ثابت)،
 * وهذا الجزء يسحبها كل 10 ثواني ويحطها في مجلد المراقبة، فتكمل مسارها العادي
 * (رقم العميل ← القروب ← الإرسال من واتساب الشركة)، ثم يرجّع النتيجة للموقع ويشوفها جهاز الفرع.
 *
 *  - اسم الملف ثابت لكل مهمة ("الفرع~الجهاز__r12-اسم الملف.pdf") => لو انقطع شيء وانسحب المستند مرة ثانية
 *    ما يتكرر الإرسال (البرنامج يعرف إنه عالجه).
 *  - الكتابة لملف مؤقت ثم إعادة التسمية، فالمراقب ما يقرأ ملف ناقص.
 *  - يتأكد من بصمة الملف قبل ما يحطه.
 *  - البرنامج هو اللي يتصل بالموقع دائماً.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateSiteUrl } = require('./warehouse-sync');
const { safeName } = require('./relay-server');

const FINAL = new Set(['sent', 'review', 'skipped', 'dry_run']);
const MAX_REMEMBERED = 5000;

/** اسم الملف المحلي لمهمة فرع: "الرياض~جهاز المحاسب 1__r12-Print_2026.pdf" */
function localFileName(job) {
  const clean = (s, fb) => safeName(String(s || '').replace(/~/g, '-'), fb);
  const base = clean(path.basename(String(job.file_name || 'document'), path.extname(String(job.file_name || ''))), 'document');
  return `${clean(job.branch, 'فرع')}~${clean(job.device_name, 'جهاز')}__r${job.job_id}-${base}.pdf`;
}

class SiteRelayInbox {
  /**
   * @param {object} o
   * @param {string} o.inboxDir   مجلد المراقبة
   * @param {string} o.stateFile  أرقام المهام وأسماء ملفاتها (لإرجاع النتيجة)
   * @param {() => {siteUrl: string, apiKey: string}} o.getConfig
   * @param {(fileName: string) => object|null} o.getOutcome      نتيجة معالجة ملف (sent/review/skipped/dry_run)
   * @param {(fileName: string) => boolean} o.alreadyHandled      البرنامج عالج هذا الملف من قبل؟
   */
  constructor({ inboxDir, stateFile, getConfig, getOutcome, alreadyHandled, shouldPull = null, log = console, fetchImpl = null, pollMs = 10000, requestTimeoutMs = 60000 }) {
    this.inboxDir = inboxDir;
    this.stateFile = stateFile;
    this.getConfig = getConfig;
    this.getOutcome = getOutcome;
    this.alreadyHandled = alreadyHandled;
    this.shouldPull = shouldPull; // الموقع يلمّح لو فيه مستندات تنتظر (بدونه: نسأل كل مرة)
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.pollMs = pollMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.timer = null;
    this.busy = false;
    this.lastError = null;
    this.lastPollAt = null;
    this.state = null;
  }

  loadState() {
    if (this.state) return this.state;
    try { this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (_) { this.state = null; }
    if (!this.state || typeof this.state.jobs !== 'object' || !this.state.jobs) this.state = { jobs: {} };
    this.syncSite();
    return this.state;
  }

  /** أرقام المهام تخص موقع واحد: لو تغيّر عنوان الموقع تبدأ من 1 من جديد، فالمحفوظ ينمسح (وإلا تنحسب "انسحبت من قبل") */
  syncSite() {
    if (this.syncingSite) return;
    const cfg = this.config();
    if (!cfg.ok) return;
    const s = this.state;
    if (s.site === cfg.url) return;
    if (s.site) s.jobs = {};
    s.site = cfg.url;
    this.syncingSite = true;
    try { this.saveState(); } catch (_) {} finally { this.syncingSite = false; }
  }

  saveState() {
    const s = this.loadState();
    const ids = Object.keys(s.jobs);
    if (ids.length > MAX_REMEMBERED) {
      // نحذف الأقدم من اللي رجعت نتيجتهم فقط
      const done = ids.filter(id => s.jobs[id].reported).sort((a, b) => Number(a) - Number(b));
      for (const id of done.slice(0, ids.length - MAX_REMEMBERED)) delete s.jobs[id];
    }
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
    fs.renameSync(tmp, this.stateFile);
  }

  config() {
    let c = {};
    try { c = this.getConfig() || {}; } catch (_) {}
    const apiKey = String(c.apiKey || '').trim();
    const v = validateSiteUrl(c.siteUrl);
    return v.ok && apiKey ? { ok: true, url: v.url, apiKey } : { ok: false };
  }

  async request(cfg, method, pathname, body) {
    const doFetch = this.fetchImpl || globalThis.fetch;
    return doFetch(`${cfg.url}/api/integration${pathname}`, {
      method,
      headers: { authorization: `Bearer ${cfg.apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
  }

  pendingCount() {
    return Object.values(this.loadState().jobs).filter(j => !j.reported).length;
  }

  /** نتائج المستندات اللي خلصت ترجع للموقع (ومن الموقع لجهاز الفرع) */
  async reportOutcomes(cfg) {
    const s = this.loadState();
    let changed = false;
    for (const [id, job] of Object.entries(s.jobs)) {
      if (job.reported) continue;
      const o = this.getOutcome(job.fileName);
      if (!o || !FINAL.has(o.status)) continue;
      const res = await this.request(cfg, 'POST', `/relay/${id}/outcome`, {
        status: o.status,
        customer_number: o.customerNumber || null,
        destination: o.destination || null,
        message: o.message || null
      });
      if (res.status === 200 || res.status === 404) {
        job.reported = true;
        job.reportedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.saveState();
  }

  /** سحب المستندات الجديدة من الموقع */
  async pull(cfg) {
    const res = await this.request(cfg, 'GET', '/relay/next?limit=3');
    if (res.status !== 200) {
      this.lastError = res.status === 401 ? 'الموقع رفض مفتاح الربط' : `رد غير متوقع من الموقع (${res.status})`;
      return 0;
    }
    const { jobs = [] } = await res.json();
    let count = 0;
    for (const job of jobs) {
      const fileName = localFileName(job);
      const target = path.join(this.inboxDir, fileName);
      const s = this.loadState();
      const known = s.jobs[String(job.job_id)];
      // انسحب من قبل (انقطع شيء قبل ما يتأكد الاستلام): ما نكتبه مرة ثانية
      if (!(known || this.alreadyHandled(fileName) || fs.existsSync(target))) {
        const fileRes = await this.request(cfg, 'GET', `/relay/${job.job_id}/file`);
        if (fileRes.status !== 200) { this.log.warn(`⚠ [الفروع] تعذر تنزيل مستند من فرع ${job.branch} (${fileRes.status})`); continue; }
        const buf = Buffer.from(await fileRes.arrayBuffer());
        if (crypto.createHash('sha256').update(buf).digest('hex') !== job.sha256) {
          this.log.warn(`⚠ [الفروع] مستند من فرع ${job.branch} وصل ناقص — بيعاد سحبه`);
          continue;
        }
        fs.mkdirSync(this.inboxDir, { recursive: true });
        const tmp = `${target}.part`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, target);
        this.log.log(`📨 [الفروع] وصل مستند من فرع ${job.branch} (${job.device_name}): ${fileName}`);
        count++;
      }
      s.jobs[String(job.job_id)] = known || { fileName, branch: job.branch, at: new Date().toISOString(), reported: false };
      this.saveState();
      await this.request(cfg, 'POST', `/relay/${job.job_id}/received`);
    }
    return count;
  }

  async tick() {
    if (this.busy) return;
    const cfg = this.config();
    if (!cfg.ok) return;
    this.busy = true;
    try {
      await this.reportOutcomes(cfg);
      if (!this.shouldPull || this.shouldPull()) await this.pull(cfg);
      this.lastError = null;
      this.lastPollAt = new Date().toISOString();
    } catch (err) {
      this.lastError = `الموقع لا يرد: ${err && err.cause && err.cause.code ? err.cause.code : (err && err.message) || err}`;
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.pollMs);
    if (this.timer.unref) this.timer.unref();
    this.tick().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return { lastPollAt: this.lastPollAt, lastError: this.lastError, waitingResults: this.pendingCount() };
  }
}

module.exports = { SiteRelayInbox, localFileName };
