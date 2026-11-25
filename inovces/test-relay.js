/**
 * اختبارات إرسال المستندات من الأجهزة الفرعية إلى الجهاز الأساسي (على نفس الجهاز، بمنافذ مؤقتة).
 * التشغيل: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createRelayServer, APP_ID } = require('./relay-server');
const { RelayClient, httpRequest } = require('./relay-client');

const PDF = fs.readFileSync(path.join(__dirname, 'samples', 'word_print_invoice_1001.pdf'));
const TRUNCATED = fs.readFileSync(path.join(__dirname, 'samples', 'word_print_truncated.pdf'));
const quiet = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) { const s = Date.now(); while (Date.now() - s < ms) { if (await fn()) return true; await sleep(50); } return !!(await fn()); }
const pdfs = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.pdf')) : [];
const randomUdpPort = () => 40000 + Math.floor(Math.random() * 20000);

function tmpDir(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function startServer(t, opts = {}) {
  const inboxDir = tmpDir(t, 'relay-inbox-');
  const dataDir = opts.dataDir || tmpDir(t, 'relay-data-');
  const outcomes = opts.outcomes || new Map();
  const discoveryPort = opts.discoveryPort || 0;
  const srv = createRelayServer({ port: opts.port || 0, host: '127.0.0.1', discoveryPort, inboxDir, dataDir, serverName: 'MAIN-PC', getOutcome: (f) => outcomes.get(f) || null, log: quiet });
  const port = await srv.ready;
  t.after(() => srv.close());
  return { srv, port, url: `http://127.0.0.1:${port}`, inboxDir, dataDir, outcomes, discoveryPort };
}

function newClient(t, { url = '', discoveryPort = 1, logs = [] } = {}) {
  const dir = tmpDir(t, 'relay-client-');
  const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const c = new RelayClient({
    credsFile: path.join(dir, 'client-device.json'),
    outboxDir: path.join(dir, 'outbox'),
    serverAddress: url,
    discoveryPort,
    discoveryTargets: ['127.0.0.1'],
    discoveryTimeoutMs: 400,
    deviceName: 'محاسب 1',
    log,
    pollMs: 100
  });
  t.after(() => c.stop());
  return { c, dir, outbox: path.join(dir, 'outbox'), logs };
}

test('الربط: رمز خاطئ يُرفض، الصحيح يربط الجهاز، والرمز يتغير بعد الاستخدام', async (t) => {
  const s = await startServer(t);
  const { c } = newClient(t, { url: s.url });
  assert.equal((await c.pair('000000' === s.srv.getPairingCode() ? '111111' : '000000')).reason, 'wrong_code');
  const code = s.srv.getPairingCode();
  const r = await c.pair(code);
  assert.equal(r.ok, true);
  assert.equal(r.serverName, 'MAIN-PC');
  assert.ok(c.isPaired());
  assert.notEqual(s.srv.getPairingCode(), code, 'الرمز يتغير بعد الربط');
  assert.equal(s.srv.listDevices().length, 1);
  assert.equal(s.srv.listDevices()[0].name, 'محاسب 1');
  assert.equal(JSON.stringify(s.srv.listDevices()).includes('token'), false, 'لا تُعرض المفاتيح');
});

test('الحماية من تخمين الرمز: بعد 5 محاولات من نفس الجهاز يُمنع مؤقتاً', async (t) => {
  const s = await startServer(t);
  const { c } = newClient(t, { url: s.url });
  const wrong = s.srv.getPairingCode() === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) assert.equal((await c.pair(wrong)).reason, 'wrong_code');
  assert.equal((await c.pair(s.srv.getPairingCode())).reason, 'too_many_attempts');
});

test('رفع بدون ربط أو بمفتاح خاطئ يُرفض', async (t) => {
  const s = await startServer(t);
  const r = await httpRequest(s.url, 'POST', '/relay/upload', { headers: { 'x-device-id': 'x', authorization: 'Bearer y', 'x-job-id': 'j1' }, body: PDF });
  assert.equal(r.status, 401);
  assert.equal(pdfs(s.inboxDir).length, 0);
});

test('جهاز منتحل على الشبكة لا يستقبل الفواتير (التحقق من هوية الجهاز الأساسي)', async (t) => {
  const s = await startServer(t);
  const { c } = newClient(t, { url: s.url });
  await c.pair(s.srv.getPairingCode());
  assert.equal(await c.verifyServer(s.url), 'ok');

  const fake = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: APP_ID, serverName: 'FAKE', proof: 'deadbeef' }));
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  t.after(() => fake.close());
  assert.equal(await c.verifyServer(`http://127.0.0.1:${fake.address().port}`), 'not_server');
});

test('من الطباعة إلى الجهاز الأساسي: الرفع، عدم التكرار، رفض الملف الناقص، ونتيجة الإرسال', async (t) => {
  const s = await startServer(t);
  const { c, outbox, logs } = newClient(t, { url: s.url });
  await c.pair(s.srv.getPairingCode());
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, 'Print_2026-11-16_12-00-00-000_001.pdf'), PDF);
  fs.writeFileSync(path.join(outbox, 'Print_2026-11-16_12-00-01-000_002.pdf'), TRUNCATED);
  c.start();

  assert.ok(await waitFor(() => pdfs(s.inboxDir).length === 1));
  const received = pdfs(s.inboxDir)[0];
  assert.equal(received, 'محاسب 1__Print_2026-11-16_12-00-00-000_001.pdf');
  assert.ok(fs.readFileSync(path.join(s.inboxDir, received)).equals(PDF));
  assert.ok(await waitFor(() => pdfs(outbox).length === 0));
  assert.equal(fs.existsSync(path.join(outbox, 'مرفوض')), false, 'الملف الناقص يُحذف ولا يُحفظ');
  const uploaded = path.join(outbox, 'تم_الرفع');
  assert.equal(pdfs(uploaded).length, 1, 'نسخة مؤقتة حتى تصل النتيجة');

  // الجهاز الأساسي يرسل الفاتورة => الجهاز الفرعي يعرض النتيجة ويحذف نسخته
  s.outcomes.set(received, { status: 'sent', customerNumber: '1001', destination: 'قروب: مؤسسة النخبة 1001' });
  assert.ok(await waitFor(() => logs.some(l => l.includes('✅') && l.includes('مؤسسة النخبة 1001') && l.includes('1001'))));
  assert.equal(c.pending.size, 0);
  assert.ok(await waitFor(() => pdfs(uploaded).length === 0), 'لا يبقى أي ملف في الجهاز الفرعي بعد تأكيد الإرسال');

  // إعادة رفع نفس الملف (مثلاً انقطعت الشبكة بعد الرفع) => لا ملف جديد
  c.stop();
  fs.writeFileSync(path.join(outbox, 'Print_2026-11-16_12-00-00-000_001.pdf'), PDF);
  c.start();
  assert.ok(await waitFor(() => pdfs(outbox).length === 0));
  await sleep(200);
  assert.equal(pdfs(s.inboxDir).length, 1, 'لا يُعالج نفس المستند مرتين');
});

test('الجهاز الفرعي أُغلق قبل وصول النتيجة: بعد تشغيله يكمل المتابعة ثم يحذف نسخته', async (t) => {
  const s = await startServer(t);
  const first = newClient(t, { url: s.url });
  await first.c.pair(s.srv.getPairingCode());
  fs.mkdirSync(first.outbox, { recursive: true });
  fs.writeFileSync(path.join(first.outbox, 'Print_restart.pdf'), PDF);
  first.c.start();
  const uploaded = path.join(first.outbox, 'تم_الرفع');
  assert.ok(await waitFor(() => pdfs(uploaded).length === 1));
  first.c.stop(); // أُغلق البرنامج قبل أن يرسل الجهاز الأساسي

  // تشغيل جديد لنفس الجهاز الفرعي (نفس المجلد وبيانات الربط)
  const logs = [];
  const again = new RelayClient({ credsFile: path.join(first.dir, 'client-device.json'), outboxDir: first.outbox, serverAddress: s.url,
    discoveryPort: 1, discoveryTargets: ['127.0.0.1'], discoveryTimeoutMs: 300, log: { log: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) }, pollMs: 100 });
  t.after(() => again.stop());
  again.start();
  assert.equal(again.pending.size, 1);
  s.outcomes.set(pdfs(s.inboxDir)[0], { status: 'review', message: 'لا يوجد قروب' });
  assert.ok(await waitFor(() => pdfs(uploaded).length === 0), 'تُحذف النسخة بعد وصول النتيجة');
  assert.ok(logs.some(l => l.includes('لا يوجد قروب')));
});

test('عدم التكرار يستمر حتى بعد إعادة تشغيل الجهاز الأساسي', async (t) => {
  const dataDir = tmpDir(t, 'relay-data-');
  const s1 = await startServer(t, { dataDir });
  const { c } = newClient(t, { url: s1.url });
  await c.pair(s1.srv.getPairingCode());
  const headers = { ...c.authHeaders(), 'x-job-id': 'job-abc', 'x-file-name': 'a.pdf' };
  assert.equal((await httpRequest(s1.url, 'POST', '/relay/upload', { headers, body: PDF })).status, 200);
  await s1.srv.close();

  const s2 = await startServer(t, { dataDir });
  const r = await httpRequest(s2.url, 'POST', '/relay/upload', { headers, body: PDF });
  assert.equal(r.status, 200);
  assert.equal(r.json.duplicate, true);
  assert.equal(pdfs(s2.inboxDir).length, 0);
});

test('البحث التلقائي: الجهاز الفرعي يجد الجهاز الأساسي بدون معرفة عنوانه', async (t) => {
  const discoveryPort = randomUdpPort();
  const s = await startServer(t, { discoveryPort });
  const { c } = newClient(t, { url: '', discoveryPort });
  const r = await c.pair(s.srv.getPairingCode());
  assert.equal(r.ok, true);
  assert.equal(c.creds.lastServer, s.url);
});

test('الجهاز الأساسي مغلق: المستندات تنتظر ثم تُرسل تلقائياً عند تشغيله', async (t) => {
  const dataDir = tmpDir(t, 'relay-data-');
  const s1 = await startServer(t, { dataDir });
  const port = s1.port;
  const { c, outbox } = newClient(t, { url: s1.url });
  await c.pair(s1.srv.getPairingCode());
  await s1.srv.close();

  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, 'Print_offline.pdf'), PDF);
  c.serverUrl = null;
  c.start();
  await sleep(600);
  assert.equal(pdfs(outbox).length, 1, 'ينتظر في الصادر');

  const s2 = await startServer(t, { dataDir, port });
  assert.ok(await waitFor(() => pdfs(s2.inboxDir).length === 1, 10000));
  assert.ok(await waitFor(() => pdfs(outbox).length === 0), 'يُنقل من الصادر بعد التأكيد');
});

test('إلغاء ربط جهاز من الجهاز الأساسي يمنعه من الإرسال', async (t) => {
  const s = await startServer(t);
  const { c, outbox, logs } = newClient(t, { url: s.url });
  await c.pair(s.srv.getPairingCode());
  assert.ok(s.srv.removeDevice(c.creds.deviceId));
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, 'Print_x.pdf'), PDF);
  c.start();
  assert.ok(await waitFor(() => logs.some(l => l.includes('ألغى ربط') || l.includes('رفض هذا الجهاز'))));
  assert.equal(pdfs(s.inboxDir).length, 0);
  assert.equal(pdfs(outbox).length, 1, 'المستند يبقى ولا يضيع');
});

test('إعادة الربط ومستند ينتظر نتيجته: لا يعلق ولا يُرفع مرة ثانية باسم الربط الجديد', async (t) => {
  const s = await startServer(t);
  const { c, outbox, logs } = newClient(t, { url: s.url });
  await c.pair(s.srv.getPairingCode());
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, 'Print_old.pdf'), PDF);
  c.start();
  const uploaded = path.join(outbox, 'تم_الرفع');
  assert.ok(await waitFor(() => pdfs(uploaded).length === 1));
  assert.equal(c.pending.size, 1);

  // إعادة الربط (ربط جديد = معرّف جهاز جديد) بينما المستند ما زال ينتظر نتيجته
  const r = await c.pair(s.srv.getPairingCode());
  assert.equal(r.ok, true);
  assert.ok(await waitFor(() => c.pending.size === 0), 'لا يبقى معلقاً للأبد');
  assert.equal(pdfs(uploaded).length, 0, 'نسخة الجهاز الفرعي تُحذف (المستند عند الجهاز الرئيسي)');
  assert.equal(pdfs(s.inboxDir).length, 1, 'رُفع مرة واحدة فقط');
  assert.ok(logs.some(l => l.includes('قبل إعادة الربط')));
});

test('تشغيل start مرتين لا يكرر العمل، وstop ينتظر انتهاء الرفع الجاري', async (t) => {
  const s = await startServer(t);
  const { c, outbox } = newClient(t, { url: s.url });
  await c.pair(s.srv.getPairingCode());
  c.start();
  const firstTimer = c.timer;
  c.start();
  assert.equal(c.timer, firstTimer, 'لا مؤقت ثانٍ');

  // رفع بطيء: stop() لا يرجع إلا بعد انتهائه، وبعدها لا يُرفع أي شيء
  fs.mkdirSync(outbox, { recursive: true });
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(outbox, `Print_s${i}.pdf`), PDF);
  await waitFor(() => c.busy, 3000);
  await c.stop();
  assert.equal(c.busy, false);
  const after = pdfs(s.inboxDir).length;
  fs.writeFileSync(path.join(outbox, 'Print_after_stop.pdf'), PDF);
  await sleep(400);
  assert.equal(pdfs(s.inboxDir).length, after, 'لا رفع بعد الإيقاف');
});

test('فسح من الجهاز الفرعي وإرسال الفسوحات موقوف: الجهاز الفرعي يعرض السبب ويحذف نسخته (لا يعلق)', async (t) => {
  const s = await startServer(t);
  const { c, outbox, logs } = newClient(t, { url: s.url });
  await c.pair(s.srv.getPairingCode());
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, 'Print_clearance.pdf'), PDF);
  c.start();
  assert.ok(await waitFor(() => pdfs(s.inboxDir).length === 1));
  const uploaded = path.join(outbox, 'تم_الرفع');
  s.outcomes.set(pdfs(s.inboxDir)[0], { status: 'skipped', customerNumber: '1001', message: 'لم يُرسل: إرسال الفسوحات موقوف من الإعدادات' });
  assert.ok(await waitFor(() => logs.some(l => l.includes('الفسوحات موقوف'))));
  assert.ok(await waitFor(() => c.pending.size === 0 && pdfs(uploaded).length === 0));
});
