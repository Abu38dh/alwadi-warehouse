/**
 * الفروع البعيدة عن طريق موقع المستودع:
 *  - site-relay-client.js (جهاز الفرع): الربط، الرفع، الانتظار لو الموقع طافي، عدم التكرار، النتيجة.
 *  - site-relay-inbox.js + index.js (الجهاز الرئيسي): السحب، الإرسال من واتساب الشركة، إرجاع النتيجة.
 * بدون إنترنت وبدون واتساب حقيقي.  التشغيل: npm test
 */
// سجل البرنامج كثير ويخلط رسائل مشغّل الاختبارات أحياناً — نسكته هنا
for (const level of ['log', 'info', 'warn', 'error']) console[level] = () => {};

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alwady-siterelay-'));
process.env.ALWADY_TEST_LOCK = process.env.ALWADY_TEST_LOCK || 'unit-siterelay';
process.env.ALWADY_NO_WINDOW = '1';
process.env.ALWADY_DATA_DIR = path.join(TMP, 'data');
process.env.INVOICES_DIR = path.join(TMP, 'invoices');
process.env.WAREHOUSE_OUTBOX_DIR = path.join(TMP, 'app-outbox');
delete process.env.WAREHOUSE_SITE_URL;
delete process.env.WAREHOUSE_API_KEY;
delete process.env.TEST_PHONE;
delete process.env.DRY_RUN;
fs.mkdirSync(process.env.ALWADY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.INVOICES_DIR, { recursive: true });

const test = require('node:test');
const assert = require('node:assert/strict');
const { SiteRelayClient } = require('./site-relay-client');
const { SiteRelayInbox, localFileName } = require('./site-relay-inbox');

const quiet = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SAMPLE = fs.readFileSync(path.join(__dirname, 'samples', 'invoice_1001.pdf'));
const pdf = (tag) => Buffer.concat([SAMPLE, Buffer.from(`\n%${tag}\n`)]);
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

/** موقع وهمي: أجهزة الفروع + صندوق المستندات + واجهة الجهاز الرئيسي */
async function startFakeSite({ apiKey = 'main-key', pairCode = 'ABCDEFGH', branch = 'الرياض' } = {}) {
  const s = { devices: [], jobs: [], down: false, pairCode, branch, installKey: 'br_test_key' };
  const server = http.createServer((req, res) => {
    if (s.down) { req.socket.destroy(); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const reply = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      // ---- أجهزة الفروع ----
      if (url.pathname === '/api/relay/pair') {
        const body = JSON.parse(raw.toString('utf8') || '{}');
        if (String(body.code).replace(/[^A-Z0-9]/gi, '').toUpperCase() !== s.pairCode) return reply(403, { ok: false });
        const d = { id: s.devices.length + 1, token: `dev_${crypto.randomBytes(8).toString('hex')}`, name: body.device_name || 'جهاز', branch: s.branch };
        s.devices.push(d);
        return reply(200, { ok: true, device_id: d.id, token: d.token, name: d.name, branch: d.branch });
      }
      if (url.pathname === '/api/relay/enroll') {
        const body = JSON.parse(raw.toString('utf8') || '{}');
        s.lastEnroll = body;
        if (body.install_key !== s.installKey) return reply(403, { ok: false, error: 'wrong_key' });
        const old = s.devices.find(x => x.name === body.device_name);
        if (old && old.off) return reply(403, { ok: false, error: 'stopped' });
        const d = old || { id: s.devices.length + 1, name: body.device_name || 'جهاز', branch: s.branch };
        d.token = `dev_${crypto.randomBytes(8).toString('hex')}`;
        if (!old) s.devices.push(d);
        return reply(200, { ok: true, device_id: d.id, token: d.token, name: d.name, branch: d.branch });
      }
      if (url.pathname.startsWith('/api/relay/')) {
        const d = s.devices.find(x => String(x.id) === req.headers['x-device-id'] && `Bearer ${x.token}` === req.headers.authorization && !x.off);
        if (!d) return reply(401, { ok: false });
        if (url.pathname === '/api/relay/hello') return reply(200, { ok: true, name: d.name, branch: d.branch });
        if (url.pathname === '/api/relay/upload') {
          const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
          const buf = Buffer.from(await form.get('pdf').arrayBuffer());
          const meta = JSON.parse(form.get('meta'));
          const h = sha(buf);
          const existing = s.jobs.find(j => j.deviceId === d.id && j.sha256 === h);
          if (existing) return reply(200, { ok: true, job_id: existing.id, duplicate: true });
          const job = { id: s.jobs.length + 1, deviceId: d.id, sha256: h, buf, file_name: meta.file_name, status: 'waiting', outcome: null, device_name: d.name, branch: d.branch };
          s.jobs.push(job);
          return reply(201, { ok: true, job_id: job.id, duplicate: false });
        }
        const m = /^\/api\/relay\/jobs\/(\d+)$/.exec(url.pathname);
        if (m) {
          const j = s.jobs.find(x => x.id === Number(m[1]) && x.deviceId === d.id);
          return j ? reply(200, { ok: true, job_id: j.id, status: j.status, outcome: j.outcome }) : reply(404, { ok: false });
        }
        return reply(404, {});
      }
      // ---- الجهاز الرئيسي ----
      if (req.headers.authorization !== `Bearer ${apiKey}`) return reply(401, { ok: false });
      if (url.pathname === '/api/integration/relay/next') {
        const jobs = s.jobs.filter(j => j.status === 'waiting').slice(0, 3);
        jobs.forEach(j => { j.status = 'taken'; });
        return reply(200, { ok: true, jobs: jobs.map(j => ({ job_id: j.id, sha256: s.corruptSha ? 'bad' : j.sha256, file_name: j.file_name, size: j.buf.length, device_name: j.device_name, branch: j.branch })) });
      }
      const f = /^\/api\/integration\/relay\/(\d+)\/(file|received|outcome)$/.exec(url.pathname);
      if (f) {
        const j = s.jobs.find(x => x.id === Number(f[1]));
        if (!j) return reply(404, { ok: false });
        if (f[2] === 'file') return reply(200, j.buf, 'application/pdf');
        if (f[2] === 'received') { if (j.status !== 'done') j.status = 'received'; j.receivedCount = (j.receivedCount || 0) + 1; return reply(200, { ok: true }); }
        j.status = 'done';
        j.outcome = JSON.parse(raw.toString('utf8'));
        return reply(200, { ok: true });
      }
      reply(404, {});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { s, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

let n = 0;
function newClient(site, extra = {}) {
  const dir = path.join(TMP, `client-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return new SiteRelayClient({ credsFile: path.join(dir, 'client-device.json'), outboxDir: path.join(dir, 'outbox'), siteUrl: site.url, deviceName: 'جهاز المحاسب 1', log: quiet, pollMs: 50, ...extra });
}

async function waitFor(fn, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await sleep(30); }
  return false;
}

// ==========================================================
// جهاز الفرع
// ==========================================================

test('الربط: رمز غلط يُرفض، والصحيح يحفظ الربط ويعرف الفرع', async () => {
  const site = await startFakeSite();
  try {
    const c = newClient(site);
    assert.equal(c.isPaired(), false);
    assert.equal((await c.pair('ZZZZ-ZZZZ', site.url)).reason, 'wrong_code');
    assert.equal((await c.pair('ABCD-EFGH', 'http://example.com')).reason, 'bad_url', 'الرابط لازم https (ما عدا هذا الجهاز)');
    const r = await c.pair('abcd-efgh', site.url);
    assert.equal(r.ok, true);
    assert.equal(r.branch, 'الرياض');
    // بعد إعادة تشغيل البرنامج: الربط محفوظ
    const again = new SiteRelayClient({ credsFile: c.credsFile, outboxDir: c.outboxDir, log: quiet });
    assert.equal(again.isPaired(), true);
    assert.equal(again.branch, 'الرياض');
    assert.equal(await again.connect(), site.url);
  } finally { await site.close(); }
});

test('المستند المطبوع ينرفع للموقع، والنتيجة ترجع وتنحذف النسخة المحلية', async () => {
  const site = await startFakeSite();
  const c = newClient(site);
  try {
    await c.pair('ABCDEFGH', site.url);
    const reviews = [];
    c.onReview = (f, reason) => reviews.push([f, reason]);
    fs.mkdirSync(c.outboxDir, { recursive: true });
    fs.writeFileSync(path.join(c.outboxDir, 'Print_001.pdf'), pdf('a'));
    fs.writeFileSync(path.join(c.outboxDir, 'Print_002.pdf'), pdf('b'));
    c.start();
    assert.ok(await waitFor(() => site.s.jobs.length === 2), 'انرفعت');
    // الموقع يسجّل المهمة قبل ما يوصل رده للجهاز، والجهاز ينقل الملف بعد الرد: ننتظر النقل
    assert.ok(await waitFor(() => fs.readdirSync(c.outboxDir).filter(f => f.endsWith('.pdf')).length === 0), 'طلعت من مجلد الصادر');
    assert.equal(fs.readdirSync(c.sentDir).length, 2, 'نسخة مؤقتة لين تجي النتيجة');

    site.s.jobs[0].status = 'done';
    site.s.jobs[0].outcome = { status: 'sent', customer_number: '1001', destination: 'قروب: مؤسسة النخبة 1001' };
    site.s.jobs[1].status = 'done';
    site.s.jobs[1].outcome = { status: 'review', message: 'لا يوجد قروب' };
    assert.ok(await waitFor(() => fs.readdirSync(c.sentDir).length === 0), 'النسخ المحلية انحذفت بعد النتيجة');
    assert.deepEqual(reviews, [['Print_002.pdf', 'لا يوجد قروب']], 'تنبيه ويندوز للمحاسب لما المستند يحتاج مراجعة');
  } finally { await c.stop(); await site.close(); }
});

test('الموقع طافي: المستندات تنتظر، وترتفع مرة وحدة بعد ما يرجع', async () => {
  const site = await startFakeSite();
  const c = newClient(site);
  try {
    await c.pair('ABCDEFGH', site.url);
    site.s.down = true;
    fs.mkdirSync(c.outboxDir, { recursive: true });
    fs.writeFileSync(path.join(c.outboxDir, 'Print_010.pdf'), pdf('down'));
    c.start();
    await sleep(300);
    assert.equal(site.s.jobs.length, 0);
    assert.equal(fs.readdirSync(c.outboxDir).filter(f => f.endsWith('.pdf')).length, 1, 'ينتظر في الصادر');
    site.s.down = false;
    assert.ok(await waitFor(() => site.s.jobs.length === 1));
    await sleep(200);
    assert.equal(site.s.jobs.length, 1, 'ما تكرر');
  } finally { await c.stop(); await site.close(); }
});

test('البرنامج انقفل قبل ما توصل النتيجة: يكمل متابعتها بدون مهمة مكررة', async () => {
  const site = await startFakeSite();
  const c = newClient(site);
  try {
    await c.pair('ABCDEFGH', site.url);
    fs.mkdirSync(c.outboxDir, { recursive: true });
    fs.writeFileSync(path.join(c.outboxDir, 'Print_020.pdf'), pdf('restart'));
    c.start();
    assert.ok(await waitFor(() => site.s.jobs.length === 1));
    await c.stop();

    const c2 = new SiteRelayClient({ credsFile: c.credsFile, outboxDir: c.outboxDir, log: quiet, pollMs: 50 });
    c2.start();
    await sleep(300);
    assert.equal(site.s.jobs.length, 1, 'نفس المهمة (الموقع يعرف الملف ببصمته)');
    site.s.jobs[0].status = 'done';
    site.s.jobs[0].outcome = { status: 'sent' };
    assert.ok(await waitFor(() => fs.readdirSync(c2.sentDir).length === 0));
    await c2.stop();
  } finally { await site.close(); }
});

test('الإدارة أوقفت الجهاز: يوقف الرفع ويطلب ربط من جديد', async () => {
  const site = await startFakeSite();
  const c = newClient(site);
  try {
    await c.pair('ABCDEFGH', site.url);
    site.s.devices[0].off = true;
    fs.mkdirSync(c.outboxDir, { recursive: true });
    fs.writeFileSync(path.join(c.outboxDir, 'Print_030.pdf'), pdf('off'));
    c.start();
    assert.ok(await waitFor(() => c.unlinked));
    assert.equal(site.s.jobs.length, 0);
    assert.equal(fs.readdirSync(c.outboxDir).filter(f => f.endsWith('.pdf')).length, 1, 'المستند ما ضاع');
  } finally { await c.stop(); await site.close(); }
});

// ==========================================================
// الجهاز الرئيسي (جدة)
// ==========================================================

test('اسم الملف المحلي ثابت لكل مهمة ويحمل الفرع والجهاز', () => {
  const name = localFileName({ job_id: 12, branch: 'الرياض', device_name: 'جهاز ~1', file_name: 'Print:2026|001.pdf' });
  assert.equal(name, 'الرياض~جهاز -1__r12-Print_2026_001.pdf', 'الرموز الممنوعة في أسماء الملفات تتبدل');
  assert.equal(localFileName({ job_id: 3, branch: 'جدة', device_name: 'ج', file_name: '..\\..\\Windows\\evil.pdf' }), 'جدة~ج__r3-evil.pdf', 'ما يقدر يكتب برا مجلد المراقبة');
});

const app = require('./index');
const { MessageMedia } = require('./wa-baileys');
const GROUP = '120363000000000021@g.us';
const WH = '120363000000000099@g.us';
const WH_DAMMAM = '120363000000000098@g.us';
const WH_NUMBER = '95123698';
const WH_DAMMAM_NUMBER = '95123697';

function fakeWhatsApp() {
  const sent = [];
  const groups = [{ id: GROUP, name: 'مؤسسة النخبة 1001' }, { id: WH, name: 'مستودع جدة 95123698' }, { id: WH_DAMMAM, name: 'مستودع الدمام 95123697' }];
  const fakeClient = {
    async getChatById(id) { const g = groups.find(x => x.id === id); return g ? { isGroup: true, id: { _serialized: g.id }, name: g.name } : null; },
    async sendMessage(chatId, content, options) { sent.push({ chatId, file: content.filename, caption: options && options.caption }); return { ack: true }; }
  };
  app._test.setWhatsApp({ ready: true, fakeClient, media: MessageMedia });
  app._test.setGroups(groups);
  return sent;
}

test('الفرع والجهاز من اسم الملف', () => {
  assert.equal(app.branchOf('الرياض~جهاز 1__r5-Print.pdf'), 'الرياض');
  assert.equal(app.sourceDeviceOf('الرياض~جهاز 1__r5-Print.pdf'), 'جهاز 1');
  assert.equal(app.branchOf('جهاز جدة__Print.pdf'), null, 'أجهزة شبكة الجهاز الرئيسي = فرعه');
  assert.equal(app.sourceDeviceOf('جهاز جدة__Print.pdf'), 'جهاز جدة');
  assert.equal(app.branchOf('Print_2026.pdf'), null);
});

test('الطريق كامل: مستند من فرع الرياض ← الجهاز الرئيسي يرسله لقروب العميل ← النتيجة ترجع للموقع', async () => {
  const site = await startFakeSite();
  const sent = fakeWhatsApp();
  app.CONFIG.delayMs = 0;
  app.applyWarehouseSettings({ siteUrl: site.url, apiKey: 'main-key' });
  const branch = newClient(site);
  try {
    await branch.pair('ABCDEFGH', site.url);
    fs.mkdirSync(branch.outboxDir, { recursive: true });
    fs.writeFileSync(path.join(branch.outboxDir, 'Print_RUH_001.pdf'), pdf('e2e'));
    branch.start();
    assert.ok(await waitFor(() => site.s.jobs.length === 1));

    const inbox = app.siteRelayInbox();
    await inbox.tick();
    const local = path.join(process.env.INVOICES_DIR, 'الرياض~جهاز المحاسب 1__r1-Print_RUH_001.pdf');
    assert.ok(fs.existsSync(local), 'وصل لمجلد المراقبة باسم فيه الفرع');
    assert.equal(site.s.jobs[0].status, 'received');

    // البرنامج يعالجه (في التشغيل الحقيقي المراقب يلتقطه لحاله)
    assert.equal(await app.handleInvoice(local), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, GROUP, 'انرسل لقروب العميل من رقم الشركة');

    await inbox.tick();
    assert.equal(site.s.jobs[0].status, 'done');
    assert.equal(site.s.jobs[0].outcome.status, 'sent');
    assert.equal(site.s.jobs[0].outcome.customer_number, '1001');
    assert.ok(await waitFor(() => fs.readdirSync(branch.sentDir).length === 0), 'جهاز الفرع استلم النتيجة');

    // انسحب مرة ثانية بالغلط (مثلاً انقطع الاتصال قبل تأكيد الاستلام): ما يُكتب ولا يُرسل مرة ثانية
    site.s.jobs[0].status = 'waiting';
    await inbox.tick();
    assert.equal(fs.existsSync(local), false);
    assert.equal(sent.length, 1);
  } finally { await branch.stop(); app.siteRelayInbox().stop(); await site.close(); }
});

test('كل فرع له مستودعه: فسح الدمام يروح لقروب مستودع الدمام (برقمه) بس، وفسح الجهاز الرئيسي لقروب مستودعه', async () => {
  const sent = fakeWhatsApp();
  app.applyWarehouseSettings({ number: WH_NUMBER, branchNumbers: {}, siteUrl: 'http://127.0.0.1:9', apiKey: 'k' });
  const sample = path.join(__dirname, 'samples', 'sample_clearance.pdf');
  try {
    // رقم مستودع الدمام ما انكتب: الفسح يروح للموقع بس، وما يروح لقروب مستودع جدة أبداً
    const f1 = path.join(process.env.INVOICES_DIR, 'الدمام~جهاز 2__r7-Print.pdf');
    fs.copyFileSync(sample, f1);
    const meta = app.buildClearanceMeta(f1, { success: true, customerNumber: '1001' });
    assert.equal(meta.branch, 'الدمام');
    assert.equal(meta.source_device, 'جهاز 2');
    await app.handleInvoice(f1);
    assert.equal(sent.length, 0, 'ما انرسل لقروب فرع ثاني');
    assert.equal(app.getOutcome('الدمام~جهاز 2__r7-Print.pdf').status, 'sent');

    // رقم مستودع الدمام: القروب يُلقى برقمه، ويطلع من قروبات العملاء
    app.applyWarehouseSettings({ branchNumbers: { 'الدمام': WH_DAMMAM_NUMBER } });
    assert.deepEqual(app.warehouseNumbers().sort(), [WH_NUMBER, WH_DAMMAM_NUMBER].sort());
    assert.equal(app.warehouseGroupFor('الدمام').number, WH_DAMMAM_NUMBER);
    assert.equal(app.warehouseGroupFor(null).number, WH_NUMBER);
    assert.equal(app.warehouseGroupFor('الرياض').number, '', 'فرع بدون رقم');
    assert.equal(app.getWarehouseSummary().branchNumbers.find(b => b.branch === 'الدمام').groupName, 'مستودع الدمام 95123697');

    const f2 = path.join(process.env.INVOICES_DIR, 'الدمام~جهاز 2__r8-Print.pdf');
    fs.copyFileSync(sample, f2);
    await app.handleInvoice(f2);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, WH_DAMMAM, 'انرسل لقروب مستودع الدمام');
    assert.match(sent[0].caption, /الفرع: الدمام/);

    // فسح الجهاز الرئيسي: قروب مستودع جدة
    const f3 = path.join(process.env.INVOICES_DIR, 'Print_main_clr.pdf');
    fs.copyFileSync(sample, f3);
    await app.handleInvoice(f3);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].chatId, WH);
    assert.doesNotMatch(sent[1].caption, /الفرع:/);

    // نفس الرقم لمستودعين: مرفوض
    assert.throws(() => app.applyWarehouseSettings({ branchNumbers: { 'الرياض': WH_NUMBER } }), /أكثر من مستودع/);
    assert.throws(() => app.applyWarehouseSettings({ branchNumbers: { 'الرياض': 'abc' } }), /قروب مستودع فرع الرياض لازم يكون أرقام/);

    // أسماء الفروع توصل من الموقع مع النبضة: فرع اسمه نفس الفرع الرئيسي = قروب المستودع الرئيسي
    app.warehouseNotifier().rememberBranches({ ok: true, main_branch: 'جدة', branches: ['جدة', 'الدمام', 'الرياض', ''] });
    assert.equal(app.warehouseGroupFor('جدة').number, WH_NUMBER);
    const summary = app.getWarehouseSummary();
    assert.equal(summary.mainBranch, 'جدة');
    assert.equal(summary.main.groupName, 'مستودع جدة 95123698');
    assert.deepEqual(summary.branchNumbers.map(b => b.branch).sort(), ['الدمام', 'الرياض'].sort(), 'الفرع الرئيسي ما يتكرر في القائمة');
    // شيل رقم الفرع
    app.applyWarehouseSettings({ branchNumbers: { 'الدمام': '' } });
    assert.equal(app.warehouseGroupFor('الدمام').number, '');
  } finally { app.applyWarehouseSettings({ number: '', branchNumbers: { 'الدمام': '' }, siteUrl: '', apiKey: '', clearApiKey: true }); }
});

test('ملف وصل ناقص (بصمة مختلفة): ما ينحط في مجلد المراقبة', async () => {
  const site = await startFakeSite();
  try {
    const c = newClient(site);
    await c.pair('ABCDEFGH', site.url);
    fs.mkdirSync(c.outboxDir, { recursive: true });
    fs.writeFileSync(path.join(c.outboxDir, 'Print_bad.pdf'), pdf('bad'));
    c.start();
    assert.ok(await waitFor(() => site.s.jobs.length === 1));
    await c.stop();
    site.s.corruptSha = true;
    const inbox = new SiteRelayInbox({
      inboxDir: path.join(TMP, 'inbox-bad'), stateFile: path.join(TMP, 'inbox-bad.json'),
      getConfig: () => ({ siteUrl: site.url, apiKey: 'main-key' }), getOutcome: () => null, alreadyHandled: () => false, log: quiet
    });
    await inbox.tick();
    assert.equal(fs.existsSync(path.join(TMP, 'inbox-bad')) ? fs.readdirSync(path.join(TMP, 'inbox-bad')).length : 0, 0);
    assert.notEqual(site.s.jobs[0].status, 'received', 'ما تأكد الاستلام => يرجع يُسحب');
  } finally { await site.close(); }
});

test('ملف الطابعة للفرع: الجهاز يتسجّل لحاله بمفتاح الفرع (بدون رمز)، والمفتاح الغلط أو الجهاز الموقوف ما يتسجّل', async () => {
  const site = await startFakeSite();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-'));
  try {
    const { readInstallConfig } = require('./index');
    const cfgFile = path.join(dir, 'site-install.json');
    assert.equal(readInstallConfig(cfgFile), null, 'بدون ملف');
    fs.writeFileSync(cfgFile, '\uFEFF' + JSON.stringify({ v: 1, siteUrl: site.url, installKey: 'br_test_key', branch: 'الرياض' }));
    const cfg = readInstallConfig(cfgFile);
    assert.equal(cfg.siteUrl, site.url);
    assert.equal(cfg.branch, 'الرياض');
    assert.match(cfg.id, /^[0-9a-f]{16}$/);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{"siteUrl": 5}');
    assert.equal(readInstallConfig(path.join(dir, 'bad.json')), null);

    const c = new SiteRelayClient({ credsFile: path.join(dir, 'creds.json'), outboxDir: path.join(dir, 'out'), deviceName: 'PC-RIYADH-1', log: quiet });
    assert.equal((await c.enroll('br_wrong', site.url, cfg.id)).reason, 'wrong_key');
    const r = await c.enroll(cfg.installKey, cfg.siteUrl, cfg.id);
    assert.equal(r.ok, true);
    assert.equal(r.branch, 'الرياض');
    assert.equal(c.isPaired(), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')).installId, cfg.id, 'يتذكر أي ملف ركّبه');
    assert.equal(await c.connect(), site.url);
    assert.equal(site.s.devices[0].name, 'PC-RIYADH-1', 'باسم الكمبيوتر');

    const firstToken = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')).token;
    await c.enroll(cfg.installKey, cfg.siteUrl, cfg.id);
    assert.equal(site.s.lastEnroll.token, firstToken, 'إعادة التسجيل ترسل مفتاح الجهاز الحالي (يثبت إنه نفس الجهاز)');
    assert.equal(site.s.lastEnroll.device_id, site.s.devices[0].id);

    site.s.devices[0].off = true;
    assert.equal((await c.enroll(cfg.installKey, cfg.siteUrl, cfg.id)).reason, 'stopped');
    site.s.down = true;
    assert.equal((await c.enroll(cfg.installKey, cfg.siteUrl, cfg.id)).reason, 'not_found');
  } finally {
    site.s.down = false;
    await site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
