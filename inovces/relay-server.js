/**
 * relay-server.js  (يعمل على الجهاز الرئيسي فقط)
 *
 * يستقبل المستندات من الأجهزة الأخرى عبر الشبكة المحلية ويضعها في مجلد المراقبة،
 * ومن هناك تكمل مسارها المعتاد (رقم العميل ← القروب ← الإرسال من واتساب الجهاز الرئيسي).
 *
 * - ربط الأجهزة برمز من 6 أرقام يظهر في واجهة الجهاز الرئيسي (يتغير بعد كل ربط ناجح).
 * - كل جهاز له مفتاح سري خاص؛ يمكن إلغاء ربط أي جهاز من الواجهة.
 * - كل ملف مرفوع له رقم مهمة؛ إعادة رفع نفس المهمة (بسبب انقطاع الشبكة) لا تسبب إرسالاً مكرراً.
 * - البحث التلقائي: الأجهزة تسأل الشبكة (UDP) عن الجهاز الرئيسي فلا حاجة لمعرفة عنوان IP.
 */

const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isPdf, isCompletePdf } = require('./print-capture');

const APP_ID = 'alwady-invoice-relay-v1';
const DISCOVER_MESSAGE = 'ALWADY_DISCOVER_V1';
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_JOBS_KEPT = 20000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (key, msg) => crypto.createHmac('sha256', String(key)).update(String(msg)).digest('hex');

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function safeName(s, fallback = 'file') {
  const cleaned = String(s || '')
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** سجل الأجهزة المرتبطة (المفاتيح محفوظة كبصمة SHA-256 فقط) */
class DeviceStore {
  constructor(file) {
    this.file = file;
    this.data = readJson(file, { devices: [] });
    if (!Array.isArray(this.data.devices)) this.data.devices = [];
  }
  save() { writeJsonAtomic(this.file, this.data); }
  add(name) {
    const id = crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(32).toString('hex');
    this.data.devices.push({ id, name: safeName(name, 'جهاز'), tokenHash: sha256(token), createdAt: new Date().toISOString(), lastSeen: null });
    this.save();
    return { id, token };
  }
  get(id) { return this.data.devices.find(d => d.id === id) || null; }
  verify(id, token) {
    const d = this.get(id);
    if (!d || !token) return null;
    return safeEqualHex(d.tokenHash, sha256(token)) ? d : null;
  }
  touch(d) { d.lastSeen = new Date().toISOString(); this.save(); }
  remove(id) {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter(d => d.id !== id);
    if (this.data.devices.length !== before) { this.save(); return true; }
    return false;
  }
  list() { return this.data.devices.map(({ tokenHash, ...rest }) => rest); }
}

/** سجل المهام المستلمة لمنع المعالجة المكررة حتى بعد إعادة تشغيل البرنامج */
class JobStore {
  constructor(file) {
    this.file = file;
    this.jobs = readJson(file, {});
  }
  key(deviceId, jobId) { return `${deviceId}:${jobId}`; }
  get(deviceId, jobId) { return this.jobs[this.key(deviceId, jobId)] || null; }
  set(deviceId, jobId, value) {
    this.jobs[this.key(deviceId, jobId)] = value;
    const keys = Object.keys(this.jobs);
    if (keys.length > MAX_JOBS_KEPT) {
      keys.sort((a, b) => (this.jobs[a].receivedAt || '').localeCompare(this.jobs[b].receivedAt || ''));
      for (const k of keys.slice(0, keys.length - MAX_JOBS_KEPT)) delete this.jobs[k];
    }
    writeJsonAtomic(this.file, this.jobs);
  }
}

function newPairingCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {object} o
 * @param {number} [o.port=3501]
 * @param {number} [o.discoveryPort=3502]  0 = بدون بحث تلقائي
 * @param {string} o.inboxDir   مجلد المراقبة الذي تُوضع فيه الملفات المستلمة
 * @param {string} o.dataDir    مكان حفظ devices.json و relay-jobs.json
 * @param {(fileName: string) => object|null} [o.getOutcome] نتيجة معالجة ملف (للرد على الجهاز المرسل)
 */
function createRelayServer({ port = 3501, host = '0.0.0.0', discoveryPort = 3502, inboxDir, dataDir, serverName = os.hostname(), getOutcome = () => null, log = console }) {
  const devices = new DeviceStore(path.join(dataDir, 'devices.json'));
  const jobs = new JobStore(path.join(dataDir, 'relay-jobs.json'));
  let pairingCode = newPairingCode();
  const pairAttempts = new Map(); // ip => {count, resetAt}

  function pairingAllowed(ip) {
    const now = Date.now();
    const a = pairAttempts.get(ip);
    if (!a || a.resetAt < now) { pairAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 }); return true; }
    a.count++;
    return a.count <= 5;
  }

  function authDevice(req) {
    const id = String(req.headers['x-device-id'] || '');
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return devices.verify(id, token);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://relay');
    const ip = req.socket.remoteAddress || '';
    try {
      // تعريف الجهاز الرئيسي: يثبت أنه الحقيقي دون كشف أي سر (لمنع جهاز منتحل من استقبال الفواتير)
      if (req.method === 'GET' && url.pathname === '/relay/hello') {
        const d = devices.get(String(url.searchParams.get('device') || ''));
        const nonce = String(url.searchParams.get('nonce') || '');
        if (!d || nonce.length < 16) return sendJson(res, 404, { app: APP_ID, error: 'unknown_device' });
        return sendJson(res, 200, { app: APP_ID, serverName, proof: hmac(d.tokenHash, nonce) });
      }

      if (req.method === 'POST' && url.pathname === '/relay/pair') {
        if (!pairingAllowed(ip)) return sendJson(res, 429, { error: 'too_many_attempts' });
        const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
        if (!safeEqualHex(String(body.code || '').trim(), pairingCode)) {
          log.warn(`⚠ [الربط] محاولة ربط برمز خاطئ من ${ip}`);
          return sendJson(res, 403, { error: 'wrong_code' });
        }
        const { id, token } = devices.add(body.deviceName);
        pairingCode = newPairingCode(); // الرمز يُستخدم مرة واحدة
        pairAttempts.delete(ip);
        log.log(`🔗 [الربط] تم ربط جهاز جديد: ${devices.get(id).name} (${ip})`);
        return sendJson(res, 200, { app: APP_ID, serverName, deviceId: id, token });
      }

      if (req.method === 'POST' && url.pathname === '/relay/upload') {
        const device = authDevice(req);
        if (!device) return sendJson(res, 401, { error: 'unauthorized' });
        const jobId = String(req.headers['x-job-id'] || '');
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(jobId)) return sendJson(res, 400, { error: 'bad_job_id' });

        const existing = jobs.get(device.id, jobId);
        if (existing) {
          req.resume();
          return sendJson(res, 200, { jobId, fileName: existing.fileName, duplicate: true });
        }

        let buffer;
        try { buffer = await readBody(req, MAX_UPLOAD_BYTES); } catch (e) {
          return sendJson(res, e.code === 'TOO_LARGE' ? 413 : 400, { error: e.code === 'TOO_LARGE' ? 'too_large' : 'read_failed' });
        }
        if (!isPdf(buffer)) return sendJson(res, 422, { error: 'not_pdf' });
        if (!isCompletePdf(buffer)) return sendJson(res, 422, { error: 'incomplete_pdf' });

        let original = 'document';
        try { original = decodeURIComponent(String(req.headers['x-file-name'] || 'document')); } catch (_) {}
        const base = `${safeName(device.name, 'جهاز')}__${safeName(path.basename(original, path.extname(original)), 'document')}`;
        fs.mkdirSync(inboxDir, { recursive: true });
        let fileName = `${base}.pdf`;
        for (let i = 2; fs.existsSync(path.join(inboxDir, fileName)); i++) fileName = `${base}_${i}.pdf`;
        const tmp = path.join(inboxDir, `${fileName}.part`);
        fs.writeFileSync(tmp, buffer);
        fs.renameSync(tmp, path.join(inboxDir, fileName));

        // الملف وصل فعلاً: أي خطأ بعد هذه النقطة لا يجعل الجهاز الفرعي يعيد الرفع (حتى لا يُرسل المستند مرتين)
        try { jobs.set(device.id, jobId, { fileName, receivedAt: new Date().toISOString() }); }
        catch (e) { log.warn(`⚠ [الأجهزة] تعذر حفظ سجل المهمة (${fileName}): ${e.message}`); }
        try { devices.touch(device); } catch (_) {}
        log.log(`📨 [الأجهزة] تم استلام مستند من "${device.name}": ${fileName}`);
        return sendJson(res, 200, { jobId, fileName });
      }

      if (req.method === 'GET' && url.pathname === '/relay/status') {
        const device = authDevice(req);
        if (!device) return sendJson(res, 401, { error: 'unauthorized' });
        const job = jobs.get(device.id, String(url.searchParams.get('job') || ''));
        if (!job) return sendJson(res, 404, { error: 'unknown_job' });
        const outcome = getOutcome(job.fileName) || { status: 'queued' };
        return sendJson(res, 200, { fileName: job.fileName, ...outcome });
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      sendJson(res, 500, { error: 'server_error' });
    }
  });

  let udp = null;
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      if (!discoveryPort) return resolve(actualPort);
      udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      udp.on('message', (msg, rinfo) => {
        if (msg.toString('utf8').trim() !== DISCOVER_MESSAGE) return;
        const reply = Buffer.from(JSON.stringify({ app: APP_ID, serverName, port: actualPort }));
        udp.send(reply, rinfo.port, rinfo.address);
      });
      udp.on('error', (e) => log.warn(`⚠ [الأجهزة] تعذر تشغيل البحث التلقائي: ${e.message}`));
      udp.bind(discoveryPort, host === '0.0.0.0' ? undefined : host, () => resolve(actualPort));
    });
  });

  return {
    ready,
    getPairingCode: () => pairingCode,
    regeneratePairingCode: () => (pairingCode = newPairingCode()),
    listDevices: () => devices.list(),
    removeDevice: (id) => devices.remove(id),
    close: () => new Promise((resolve) => {
      try { if (udp) udp.close(); } catch (_) {}
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    })
  };
}

module.exports = { createRelayServer, APP_ID, DISCOVER_MESSAGE, sha256, hmac, safeName };
