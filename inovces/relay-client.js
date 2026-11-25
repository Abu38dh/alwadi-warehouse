/**
 * relay-client.js  (يعمل على الأجهزة الأخرى — بدون واتساب)
 *
 * - المستندات المطبوعة على طابعة البرنامج تُحفظ في مجلد الصادر (outbox).
 * - يبحث عن الجهاز الرئيسي تلقائياً في الشبكة ويتأكد أنه الحقيقي قبل إرسال أي ملف.
 * - يرفع كل ملف للجهاز الرئيسي، وإذا كان مغلقاً تنتظر الملفات وتُرسل تلقائياً عند عودته.
 * - يعرض نتيجة كل مستند: أُرسل لقروب كذا / نُقل للمراجعة مع السبب.
 */

const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { APP_ID, DISCOVER_MESSAGE, sha256, hmac } = require('./relay-server');

function httpRequest(baseUrl, method, pathname, { headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const req = http.request(url, { method, headers: { ...headers, ...(body ? { 'Content-Length': body.length } : {}) }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** عناوين البث لكل شبكة متصلة بهذا الجهاز */
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

/** سؤال الشبكة: "وين الجهاز الرئيسي؟" */
function discoverServers({ discoveryPort = 3502, timeoutMs = 2500, targets = broadcastAddresses() } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => { try { sock.close(); } catch (_) {} resolve([...found.values()]); });
    sock.on('message', (msg, rinfo) => {
      try {
        const j = JSON.parse(msg.toString('utf8'));
        if (j.app === APP_ID && j.port) found.set(`${rinfo.address}:${j.port}`, { url: `http://${rinfo.address}:${j.port}`, serverName: j.serverName });
      } catch (_) {}
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const msg = Buffer.from(DISCOVER_MESSAGE);
      for (const t of targets) sock.send(msg, discoveryPort, t, () => {});
    });
    setTimeout(() => { try { sock.close(); } catch (_) {} resolve([...found.values()]); }, timeoutMs);
  });
}

function normalizeServerAddress(addr, defaultPort) {
  const s = String(addr || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  return s.includes(':') ? `http://${s}` : `http://${s}:${defaultPort}`;
}

class RelayClient {
  /**
   * @param {object} o
   * @param {string} o.credsFile   ملف بيانات الربط (معرّف الجهاز والمفتاح)
   * @param {string} o.outboxDir   مجلد الصادر
   * @param {string} [o.serverAddress] عنوان الجهاز الرئيسي يدوياً (اختياري: اسم الجهاز أو IP)
   */
  constructor({ credsFile, outboxDir, serverAddress = '', relayPort = 3501, discoveryPort = 3502, discoveryTargets, discoveryTimeoutMs = 2500, deviceName = os.hostname(), log = console, pollMs = 2000 }) {
    this.discoveryTimeoutMs = discoveryTimeoutMs;
    this.credsFile = credsFile;
    this.outboxDir = outboxDir;
    this.sentDir = path.join(outboxDir, 'تم_الرفع');
    this.serverAddress = serverAddress;
    this.relayPort = relayPort;
    this.discoveryPort = discoveryPort;
    this.discoveryTargets = discoveryTargets;
    this.deviceName = deviceName;
    this.log = log;
    this.pollMs = pollMs;
    this.creds = null;
    this.serverUrl = null;
    this.pending = new Map(); // jobId => {fileName, since}
    this.timer = null;
    this.busy = false;
    this.stopped = true;
    this.tickPromise = null;
    this.lastOfflineLog = 0;
    try { this.creds = JSON.parse(fs.readFileSync(credsFile, 'utf8')); } catch (_) {}
  }

  isPaired() { return !!(this.creds && this.creds.deviceId && this.creds.token); }

  authHeaders() { return { 'x-device-id': this.creds.deviceId, authorization: `Bearer ${this.creds.token}` }; }

  /** العناوين المعروفة: العنوان اليدوي في الإعدادات ثم آخر عنوان نجح */
  knownUrls() {
    const urls = [];
    const manual = normalizeServerAddress(this.serverAddress, this.relayPort);
    if (manual) urls.push(manual);
    if (this.creds && this.creds.lastServer) urls.push(this.creds.lastServer);
    return [...new Set(urls)];
  }

  /** البحث في الشبكة عن الجهاز الرئيسي */
  async discoveredUrls() {
    const found = await discoverServers({
      discoveryPort: this.discoveryPort,
      timeoutMs: this.discoveryTimeoutMs,
      ...(this.discoveryTargets ? { targets: this.discoveryTargets } : {})
    });
    return found.map(f => f.url);
  }

  async candidateUrls() {
    return [...new Set([...this.knownUrls(), ...(await this.discoveredUrls())])];
  }

  /** التأكد أن العنوان هو الجهاز الرئيسي الحقيقي المرتبط به هذا الجهاز */
  async verifyServer(url) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const r = await httpRequest(url, 'GET', `/relay/hello?device=${encodeURIComponent(this.creds.deviceId)}&nonce=${nonce}`, { timeoutMs: 4000 });
    if (r.status === 404 && r.json && r.json.app === APP_ID) return 'unknown_device';
    if (r.status !== 200 || !r.json || r.json.app !== APP_ID) return 'not_server';
    return r.json.proof === hmac(sha256(this.creds.token), nonce) ? 'ok' : 'not_server';
  }

  /** الربط بالجهاز الرئيسي برمز الربط الظاهر في واجهته */
  async pair(code) {
    const urls = await this.candidateUrls();
    if (urls.length === 0) return { ok: false, reason: 'not_found' };
    for (const url of urls) {
      try {
        const r = await httpRequest(url, 'POST', '/relay/pair', {
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify({ code: String(code).trim(), deviceName: this.deviceName }))
        });
        if (r.status === 200 && r.json && r.json.app === APP_ID) {
          this.creds = { deviceId: r.json.deviceId, token: r.json.token, serverName: r.json.serverName, lastServer: url };
          fs.writeFileSync(this.credsFile, JSON.stringify(this.creds, null, 2), 'utf8');
          this.serverUrl = url;
          return { ok: true, serverName: r.json.serverName };
        }
        if (r.status === 403) return { ok: false, reason: 'wrong_code' };
        if (r.status === 429) return { ok: false, reason: 'too_many_attempts' };
      } catch (_) {}
    }
    return { ok: false, reason: 'not_found' };
  }

  async connect() {
    if (this.serverUrl) return this.serverUrl;
    const known = this.knownUrls();
    const ok = await this._connectFrom(known);
    if (ok) return ok;
    // العنوان القديم لم يعد يعمل (ربما تغيّر IP الجهاز الرئيسي) => البحث في الشبكة
    const discovered = (await this.discoveredUrls()).filter(u => !known.includes(u));
    return this._connectFrom(discovered);
  }

  async _connectFrom(urls) {
    for (const url of urls) {
      try {
        const v = await this.verifyServer(url);
        if (v === 'ok') {
          this.serverUrl = url;
          if (this.creds.lastServer !== url) {
            this.creds.lastServer = url;
            fs.writeFileSync(this.credsFile, JSON.stringify(this.creds, null, 2), 'utf8');
          }
          this.log.log(`🔗 متصل بالجهاز الرئيسي (${this.creds.serverName || url})`);
          return url;
        }
        if (v === 'unknown_device') {
          if (!this.unlinked) this.log.error('❌ الجهاز الرئيسي ألغى ربط هذا الجهاز. اضغط "إعادة الربط" وأدخل رمز الربط الجديد.');
          this.unlinked = true;
        }
      } catch (_) {}
    }
    return null;
  }

  /**
   * رقم المهمة ثابت لكل مستند (حتى لا يُرسل نفس المستند مرتين بعد إعادة التشغيل)،
   * ويعتمد على الاسم والمحتوى معاً حتى لا يُخلط بين مستندين مختلفين لهما نفس الاسم.
   */
  jobIdFor(fileName, content) {
    const contentHash = crypto.createHash('sha256').update(content || Buffer.alloc(0)).digest('hex').slice(0, 16);
    return fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) + '-' + sha256(fileName).slice(0, 8) + '-' + contentHash;
  }

  start() {
    if (this.timer) return; // يعمل أصلاً: لا تشغيل مكرر
    this.stopped = false;
    fs.mkdirSync(this.outboxDir, { recursive: true });
    // ملفات رُفعت سابقاً ولم تصل نتيجتها (مثلاً أُغلق البرنامج): نكمل متابعتها ثم نحذفها
    try {
      for (const f of fs.readdirSync(this.sentDir).filter(x => x.toLowerCase().endsWith('.pdf'))) {
        const jobId = this.jobIdFor(f.replace(/^\d{13}_/, ''), fs.readFileSync(path.join(this.sentDir, f)));
        if (!this.pending.has(jobId)) this.pending.set(jobId, { fileName: f, localPath: path.join(this.sentDir, f), since: Date.now() });
      }
    } catch (_) {}
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

  /** إيقاف كامل: ينتظر انتهاء أي رفع جارٍ حتى لا يرفع نفس المستند جهازان (قبل وبعد إعادة الربط) */
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    if (this.tickPromise) { try { await this.tickPromise; } catch (_) {} }
  }

  outboxFiles() {
    try {
      return fs.readdirSync(this.outboxDir)
        .filter(f => f.toLowerCase().endsWith('.pdf'))
        .map(f => ({ f, t: fs.statSync(path.join(this.outboxDir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t)
        .map(x => x.f);
    } catch (_) { return []; }
  }

  moveTo(dir, fileName) {
    fs.mkdirSync(dir, { recursive: true });
    let target = path.join(dir, fileName);
    if (fs.existsSync(target)) target = path.join(dir, `${Date.now()}_${fileName}`);
    fs.renameSync(path.join(this.outboxDir, fileName), target);
    return target;
  }

  deleteLocal(filePath) {
    try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
  }

  async processOutbox() {
    if (!this.isPaired()) return;
    const files = this.outboxFiles();
    if (files.length === 0) return;
    const url = await this.connect();
    if (!url) {
      if (Date.now() - this.lastOfflineLog > 60000) {
        this.lastOfflineLog = Date.now();
        this.log.warn(`⏳ الجهاز الرئيسي غير متاح حالياً (مغلق أو ليس على نفس الشبكة). يوجد (${files.length}) مستند بانتظار الإرسال وسيُرسل تلقائياً.`);
      }
      return;
    }
    for (const fileName of files) {
      if (this.stopped) return;
      const full = path.join(this.outboxDir, fileName);
      let body;
      try { body = fs.readFileSync(full); } catch (_) { continue; }
      const jobId = this.jobIdFor(fileName, body);
      let r;
      try {
        r = await httpRequest(url, 'POST', '/relay/upload', {
          headers: { ...this.authHeaders(), 'Content-Type': 'application/pdf', 'x-job-id': jobId, 'x-file-name': encodeURIComponent(fileName) },
          body,
          timeoutMs: 60000
        });
      } catch (e) {
        this.serverUrl = null; // ربما تغيّر عنوان الجهاز الرئيسي؛ سيبحث عنه من جديد
        return;
      }
      if (r.status === 200) {
        // نسخة مؤقتة حتى تصل النتيجة النهائية من الجهاز الرئيسي، ثم تُحذف
        const localPath = this.moveTo(this.sentDir, fileName);
        this.pending.set(jobId, { fileName, localPath, since: Date.now() });
        this.log.log(`📤 تم رفع (${fileName}) للجهاز الرئيسي${r.json && r.json.duplicate ? ' (كان مرفوعاً مسبقاً)' : ''}، بانتظار الإرسال...`);
      } else if (r.status === 422) {
        this.deleteLocal(full);
        this.log.warn(`⚠ رفض الجهاز الرئيسي الملف (${fileName}) لأنه ${r.json && r.json.error === 'incomplete_pdf' ? 'ناقص' : 'ليس PDF'}، وتم حذفه.`);
      } else if (r.status === 401) {
        this.serverUrl = null;
        if (!this.unlinked) this.log.error('❌ الجهاز الرئيسي ألغى ربط هذا الجهاز. اضغط "إعادة الربط" وأدخل رمز الربط الجديد.');
        this.unlinked = true;
        return;
      } else {
        this.log.warn(`⚠ تعذر رفع (${fileName}) (رمز ${r.status})، سيُعاد المحاولة.`);
        return;
      }
    }
  }

  async checkPending() {
    if (this.pending.size === 0 || !this.isPaired()) return;
    if (!this.serverUrl && !(await this.connect())) return;
    for (const [jobId, info] of this.pending) {
      if (this.stopped) return;
      let r;
      try { r = await httpRequest(this.serverUrl, 'GET', `/relay/status?job=${encodeURIComponent(jobId)}`, { headers: this.authHeaders(), timeoutMs: 8000 }); } catch (_) { return; }
      if (r.status === 404 && r.json && r.json.error === 'unknown_job') {
        // رُفع قبل "إعادة الربط" (باسم الربط القديم): المستند وصل للجهاز الرئيسي ونتيجته تظهر هناك،
        // ولا يُعاد رفعه حتى لا يُرسل للعميل مرتين
        this.log.log(`ℹ (${info.fileName}): رُفع للجهاز الرئيسي قبل إعادة الربط — نتيجته تظهر في الجهاز الرئيسي.`);
        this.deleteLocal(info.localPath);
        this.pending.delete(jobId);
        continue;
      }
      if (r.status !== 200 || !r.json) continue;
      const o = r.json;
      if (o.status === 'sent') {
        this.log.log(`✅ (${info.fileName}): انرسل للعميل [${o.customerNumber || '-'}] ← ${o.destination || ''}`);
      } else if (o.status === 'review') {
        this.log.warn(`⚠ (${info.fileName}): لم يُرسل ونُقل للمراجعة في الجهاز الرئيسي — ${o.message || ''}`);
        if (typeof this.onReview === 'function') { try { this.onReview(info.fileName, o.message || ''); } catch (_) {} }
      } else if (o.status === 'skipped') {
        this.log.log(`⏸ (${info.fileName}): ${o.message || 'لم يُرسل (موقوف من الإعدادات)'}`);
      } else if (o.status === 'dry_run') {
        this.log.log(`🧪 (${info.fileName}): تشغيل تجريبي — ${o.message || ''}`);
      } else {
        continue; // ما زال في الانتظار
      }
      // النتيجة النهائية وصلت: المستند الآن عند الجهاز الرئيسي (أُرسل أو في مراجعته) => حذف نسخة هذا الجهاز
      this.deleteLocal(info.localPath);
      this.pending.delete(jobId);
    }
  }
}

module.exports = { RelayClient, discoverServers, broadcastAddresses, normalizeServerAddress, httpRequest };
