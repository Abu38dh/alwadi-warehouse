/**
 * اختبارات مسار المستودع: الفسح يذهب لقروب المستودع + موقع المستودع (بدون واتساب حقيقي وبدون إنترنت).
 * - warehouse-sync.js: مجلد الانتظار، الرفع، إعادة المحاولة، عدم التكرار.
 * - index.js: مسار الفسح بعميل واتساب وهمي وموقع وهمي على نفس الجهاز.
 * التشغيل: npm test
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// سجل البرنامج كثير ويكتب على نفس القناة اللي يستخدمها مشغّل الاختبارات مع هذا الملف،
// فيخلط رسائله أحياناً ("Unable to deserialize cloned data") ويفشل الملف عشوائياً — نسكته هنا.
for (const level of ['log', 'info', 'warn', 'error']) console[level] = () => {};

// كل ملفات الاختبار في مجلد مؤقت: لا شيء يلمس بيانات البرنامج الحقيقية
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alwady-warehouse-'));
process.env.ALWADY_TEST_LOCK = process.env.ALWADY_TEST_LOCK || 'unit-warehouse';
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
const { WarehouseSync, validateSiteUrl } = require('./warehouse-sync');
const { buildGroupIndex, findGroupForCustomer, customerNameFromGroupName } = require('./group-matcher');

const SAMPLE_CLEARANCE = path.join(__dirname, 'samples', 'sample_clearance.pdf'); // رقم العميل 1001
const quiet = { log() {}, warn() {}, error() {} };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

/** موقع مستودع وهمي: يستقبل المستندات ويحفظ ما وصله. respond يحدد الرد (الافتراضي: استلام صحيح بدون تكرار) */
async function startFakeSite({ apiKey = 'secret-key', respond = null } = {}) {
  const received = [];
  const seen = new Set();
  const state = { down: false }; // down = الموقع مطفي: يقطع الاتصال بدون أي رد
  const server = http.createServer((req, res) => {
    if (state.down) { req.socket.destroy(); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      try {
        if (req.method !== 'POST' || req.url !== '/api/integration/documents') return reply(404, { ok: false });
        if (req.headers.authorization !== `Bearer ${apiKey}`) return reply(401, { ok: false, error: 'unauthorized' });
        const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const meta = JSON.parse(form.get('meta'));
        const pdf = Buffer.from(await form.get('pdf').arrayBuffer());
        const sha = sha256(pdf);
        received.push({ meta, sha, size: pdf.length });
        if (respond) { const r = respond({ meta, sha, count: received.length }); if (r) return reply(r.status, r.body); }
        const duplicate = seen.has(sha);
        seen.add(sha);
        reply(duplicate ? 200 : 201, { ok: true, duplicate, sha256: sha });
      } catch (err) { reply(500, { ok: false, error: err.message }); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    received,
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.closeAllConnections && server.closeAllConnections(); server.close(() => resolve()); })
  };
}

function newSync(name, cfg, extra = {}) {
  return new WarehouseSync({ outboxDir: path.join(TMP, name), getConfig: () => cfg, log: quiet, backoffStepsMs: [40, 80], requestTimeoutMs: 4000, ...extra });
}

async function waitFor(fn, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}

// ==========================================================
// warehouse-sync.js
// ==========================================================

test('رابط الموقع: https فقط، و http لنفس الجهاز للتجربة', () => {
  assert.equal(validateSiteUrl('https://warehouse.example.com/').url, 'https://warehouse.example.com');
  assert.equal(validateSiteUrl('http://localhost:4000').ok, true);
  assert.equal(validateSiteUrl('http://127.0.0.1:4000/').url, 'http://127.0.0.1:4000');
  assert.equal(validateSiteUrl('http://warehouse.example.com').ok, false, 'http على الإنترنت يكشف مفتاح الربط');
  assert.equal(validateSiteUrl('warehouse.example.com').ok, false);
  assert.equal(validateSiteUrl('https://user:pass@example.com').ok, false);
  assert.equal(validateSiteUrl('').ok, false);
});

test('الفسح يُرفع للموقع ببياناته وبمفتاح الربط، ثم يُحذف من مجلد الانتظار', async () => {
  const site = await startFakeSite();
  const sync = newSync('s1', { siteUrl: site.url, apiKey: 'secret-key' });
  try {
    sync.start();
    const r = sync.queueForWarehouse(SAMPLE_CLEARANCE, { doc_type: 'clearance', customer_number: '1001', meta_problems: [] });
    assert.equal(r.queued, true);
    assert.ok(await waitFor(() => sync.pendingCount() === 0), 'لم يُرفع');
    assert.equal(site.received.length, 1);
    assert.equal(site.received[0].sha, sha256(fs.readFileSync(SAMPLE_CLEARANCE)));
    assert.equal(site.received[0].meta.sha256, site.received[0].sha);
    assert.equal(site.received[0].meta.customer_number, '1001');
    assert.equal(site.received[0].meta.file_name, 'sample_clearance.pdf');
    assert.deepEqual(fs.readdirSync(sync.outboxDir).filter(n => /\.(pdf|json)$/.test(n) && n !== 'state.json'), []);
    assert.equal(sync.status().lastError, null);
  } finally { await sync.stop(); await site.close(); }
});

test('نفس الملف لا يُضاف مرتين، ولا يُعاد رفعه بعد استلام الموقع له', async () => {
  const site = await startFakeSite();
  const sync = newSync('s2', { siteUrl: site.url, apiKey: 'secret-key' });
  try {
    assert.equal(sync.queueForWarehouse(SAMPLE_CLEARANCE, {}).queued, true);
    assert.equal(sync.queueForWarehouse(SAMPLE_CLEARANCE, {}).already, true, 'مرتين قبل الرفع');
    assert.equal(sync.pendingCount(), 1);
    sync.start();
    assert.ok(await waitFor(() => sync.pendingCount() === 0));
    assert.equal(sync.queueForWarehouse(SAMPLE_CLEARANCE, {}).already, true, 'بعد استلام الموقع');
    assert.equal(sync.pendingCount(), 0);
    // حتى بعد إعادة تشغيل البرنامج (الحالة محفوظة في ملف)
    const again = newSync('s2', { siteUrl: site.url, apiKey: 'secret-key' });
    assert.equal(again.queueForWarehouse(SAMPLE_CLEARANCE, {}).already, true);
    assert.equal(site.received.length, 1);
  } finally { await sync.stop(); await site.close(); }
});

test('الموقع مطفي: الفسح ينتظر ولا يضيع، ويوصل مرة واحدة بعد رجوع الموقع', async () => {
  const site = await startFakeSite();
  site.state.down = true;
  const sync = newSync('s3', { siteUrl: site.url, apiKey: 'secret-key' });
  try {
    sync.start();
    sync.queueForWarehouse(SAMPLE_CLEARANCE, { customer_number: '1001' });
    assert.ok(await waitFor(() => sync.failures >= 2), 'لم يُعد المحاولة');
    assert.equal(sync.pendingCount(), 1, 'الملف باقٍ في مجلد الانتظار');
    assert.match(sync.status().lastError, /الموقع لا يرد/);
    assert.equal(site.received.length, 0);

    site.state.down = false;
    assert.ok(await waitFor(() => sync.pendingCount() === 0), 'لم يوصل بعد رجوع الموقع');
    assert.equal(site.received.length, 1, 'وصل مرة واحدة فقط');
    assert.equal(sync.failures, 0);
  } finally { await sync.stop(); await site.close(); }
});

test('انقطع الرد بعد استلام الموقع (لم يصل التأكيد): يُعاد الرفع والموقع يرد "موجود مسبقاً" بدون تكرار', async () => {
  let first = true;
  const site = await startFakeSite({
    respond: () => { if (first) { first = false; return { status: 502, body: { ok: false } }; } return null; }
  });
  const sync = newSync('s4', { siteUrl: site.url, apiKey: 'secret-key' });
  try {
    sync.start();
    sync.queueForWarehouse(SAMPLE_CLEARANCE, {});
    assert.ok(await waitFor(() => sync.pendingCount() === 0));
    assert.equal(site.received.length, 2, 'محاولتان لنفس الملف');
    assert.equal(site.received[0].sha, site.received[1].sha, 'نفس البصمة => الموقع يعرف أنه مكرر');
  } finally { await sync.stop(); await site.close(); }
});

test('مفتاح ربط خاطئ: لا يُحذف الملف ولا يُرفض — ينتظر تصحيح المفتاح', async () => {
  const site = await startFakeSite({ apiKey: 'the-right-key' });
  const cfg = { siteUrl: site.url, apiKey: 'wrong-key' };
  const sync = newSync('s5', cfg);
  try {
    sync.start();
    sync.queueForWarehouse(SAMPLE_CLEARANCE, {});
    assert.ok(await waitFor(() => sync.failures >= 1));
    assert.equal(sync.pendingCount(), 1);
    assert.equal(sync.rejectedCount(), 0);
    assert.match(sync.status().lastError, /مفتاح الربط/);
    cfg.apiKey = 'the-right-key';
    sync.kick(); // حفظ الإعدادات يطلب محاولة فورية
    assert.ok(await waitFor(() => sync.pendingCount() === 0));
    assert.equal(site.received.length, 1);
  } finally { await sync.stop(); await site.close(); }
});

test('ملف رفضه الموقع نهائياً: يُنقل إلى rejected (لا يُحذف) ولا يعطّل ما بعده', async () => {
  const other = path.join(TMP, 'other.pdf');
  fs.writeFileSync(other, Buffer.concat([fs.readFileSync(SAMPLE_CLEARANCE), Buffer.from('\n%other')]));
  const badSha = sha256(fs.readFileSync(SAMPLE_CLEARANCE));
  const site = await startFakeSite({
    respond: ({ sha }) => (sha === badSha ? { status: 400, body: { ok: false, message: 'ليس ملف PDF صالح' } } : null)
  });
  const sync = newSync('s6', { siteUrl: site.url, apiKey: 'secret-key' });
  try {
    sync.queueForWarehouse(SAMPLE_CLEARANCE, {});
    sync.queueForWarehouse(other, {});
    sync.start();
    assert.ok(await waitFor(() => sync.pendingCount() === 0));
    assert.equal(sync.rejectedCount(), 1);
    assert.ok(fs.existsSync(path.join(sync.rejectedDir, `${badSha}.pdf`)), 'الملف المرفوض محفوظ');
    assert.match(fs.readFileSync(path.join(sync.rejectedDir, `${badSha}.reason.txt`), 'utf8'), /ليس ملف PDF صالح/);
    assert.equal(site.received.length, 2, 'الملف الثاني وصل');
  } finally { await sync.stop(); await site.close(); }
});

test('رد نجاح بدون تأكيد بصمة الملف لا يُعتبر استلاماً (لا يُحذف الملف)', async () => {
  const site = await startFakeSite({ respond: () => ({ status: 200, body: { ok: true } }) });
  const sync = newSync('s7', { siteUrl: site.url, apiKey: 'secret-key' });
  try {
    sync.start();
    sync.queueForWarehouse(SAMPLE_CLEARANCE, {});
    assert.ok(await waitFor(() => sync.failures >= 1));
    assert.equal(sync.pendingCount(), 1);
  } finally { await sync.stop(); await site.close(); }
});

test('بدون إعدادات الموقع: الملف ينتظر في المجلد ولا يحصل أي اتصال', async () => {
  let calls = 0;
  const sync = newSync('s8', { siteUrl: '', apiKey: '' }, { fetchImpl: async () => { calls++; throw new Error('no'); } });
  try {
    sync.start();
    sync.queueForWarehouse(SAMPLE_CLEARANCE, {});
    await new Promise(r => setTimeout(r, 120));
    assert.equal(calls, 0);
    assert.equal(sync.pendingCount(), 1);
    assert.equal(sync.status().configured, false);
  } finally { await sync.stop(); }
});

// ==========================================================
// group-matcher.js: قروب المستودع ليس قروب عميل
// ==========================================================

test('قروب المستودع لا يُطابَق كقروب عميل أبداً ولا يظهر في القروبات المتجاهَلة', () => {
  const groups = [
    { id: 'c1@g.us', name: 'مؤسسة النخبة 1001' },
    { id: 'wh@g.us', name: 'مستودع الوادي 1094' },
    { id: 'wh2@g.us', name: 'المستودع' }
  ];
  const before = buildGroupIndex(groups, { minDigits: 4 });
  assert.equal(findGroupForCustomer(before, '1094').status, 'match', 'بدون استثناء كان سيُطابَق كقروب العميل 1094');

  const index = buildGroupIndex(groups, { minDigits: 4, excludeIds: ['wh@g.us', 'wh2@g.us'] });
  assert.equal(findGroupForCustomer(index, '1094').status, 'none');
  assert.equal(findGroupForCustomer(index, '1001').status, 'match');
  assert.deepEqual(index.invalid, [], 'لا تحذير "قروب بدون رقم" لقروب المستودع');
});

test('اسم العميل من اسم قروبه (بدون الرقم والفواصل)', () => {
  assert.equal(customerNameFromGroupName('مؤسسة النخبة 1001'), 'مؤسسة النخبة');
  assert.equal(customerNameFromGroupName('١٠٠٢ - شركة الأمل'), 'شركة الأمل');
  assert.equal(customerNameFromGroupName('ورشة السرعة (11001)'), 'ورشة السرعة');
  assert.equal(customerNameFromGroupName('1001'), '');
});

// ==========================================================
// index.js: مسار الفسح
// ==========================================================

const app = require('./index');
const { MessageMedia } = require('./wa-baileys');

const WH_GROUP = '120363000000000001@g.us';
const WH_NUMBER = '95123698';
const CUSTOMER_GROUP = '120363000000000002@g.us';
const GROUPS = [
  { id: CUSTOMER_GROUP, name: 'مؤسسة النخبة 1001' },
  { id: WH_GROUP, name: 'مستودع جدة 95123698' }
];

function fakeWhatsApp({ groupExists = true } = {}) {
  const sent = [];
  const fakeClient = {
    async getChatById(id) {
      if (!groupExists) return null;
      const g = GROUPS.find(x => x.id === id);
      return g ? { isGroup: true, id: { _serialized: g.id }, name: g.name } : null;
    },
    async getNumberId(phone) { return { _serialized: `${phone}@c.us` }; },
    async sendMessage(chatId, media, options) {
      sent.push({ chatId, fileName: media.filename, caption: options.caption });
      return { ack: true };
    }
  };
  app._test.setWhatsApp({ ready: true, fakeClient, media: MessageMedia });
  app._test.setGroups(GROUPS);
  return sent;
}

let fileCounter = 0;
function newClearanceFile() {
  // محتوى مختلف قليلاً لكل ملف (بصمة مختلفة) مع بقاء الـ PDF صالحاً للقراءة
  const target = path.join(process.env.INVOICES_DIR, `Print_test_${++fileCounter}.pdf`);
  fs.writeFileSync(target, Buffer.concat([fs.readFileSync(SAMPLE_CLEARANCE), Buffer.from(`\n%test-${fileCounter}\n`)]));
  return target;
}

function appOutbox() {
  let names = [];
  try { names = fs.readdirSync(process.env.WAREHOUSE_OUTBOX_DIR); } catch (_) {}
  return names.filter(n => /^[0-9a-f]{64}\.json$/.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(process.env.WAREHOUSE_OUTBOX_DIR, n), 'utf8')));
}

function clearAppOutbox() {
  try { fs.rmSync(process.env.WAREHOUSE_OUTBOX_DIR, { recursive: true, force: true }); } catch (_) {}
  app.warehouseSync().state = null;
}

function resetWarehouse({ number = '', siteUrl = '', apiKey = '' } = {}) {
  app.CONFIG.dryRun = false;
  app.CONFIG.testPhone = '';
  app.CONFIG.deleteAfterSend = true;
  app.applyWarehouseSettings({ number, branchNumbers: {}, siteUrl, apiKey, clearApiKey: !apiKey });
  clearAppOutbox();
}

// موقع غير موجود: العامل الخلفي غير مشغَّل في الاختبارات، فالملفات تبقى في مجلد الانتظار لنفحصها
const SITE = { siteUrl: 'http://127.0.0.1:9', apiKey: 'k' };

test('بدون إعدادات المستودع: الفسح على سلوكه السابق (موقوف => مجلد Stopped) ولا شيء يُرسل', async () => {
  const sent = fakeWhatsApp();
  resetWarehouse();
  assert.equal(app.isWarehouseRouteActive(), false);
  const file = newClearanceFile();
  assert.equal(await app.handleInvoice(file), false);
  assert.equal(sent.length, 0);
  assert.ok(fs.existsSync(path.join(process.env.INVOICES_DIR, 'Stopped', 'فسوحات', path.basename(file))));
  assert.equal(appOutbox().length, 0);
});

test('الفسح يذهب لقروب المستودع + مجلد انتظار الموقع، وليس لقروب العميل', async () => {
  const sent = fakeWhatsApp();
  resetWarehouse({ number: WH_NUMBER, ...SITE });
  const file = newClearanceFile();
  const expectedSha = sha256(fs.readFileSync(file));

  assert.equal(await app.handleInvoice(file), true);

  assert.equal(sent.length, 1, 'رسالة واحدة فقط');
  assert.equal(sent[0].chatId, WH_GROUP);
  assert.notEqual(sent[0].chatId, CUSTOMER_GROUP);
  assert.equal(sent[0].fileName, 'فسح 1001.pdf');
  assert.match(sent[0].caption, /فسح جديد للتجهيز/);
  assert.match(sent[0].caption, /مؤسسة النخبة — 1001/);

  const queued = appOutbox();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].sha256, expectedSha);
  assert.equal(queued[0].doc_type, 'clearance');
  assert.equal(queued[0].customer_number, '1001');
  assert.equal(queued[0].customer_name, 'مؤسسة النخبة');
  assert.deepEqual(queued[0].meta_problems, []);
  assert.ok(fs.existsSync(path.join(process.env.WAREHOUSE_OUTBOX_DIR, `${expectedSha}.pdf`)), 'نسخة الموقع أُخذت قبل حذف الملف');
  assert.equal(fs.existsSync(file), false, 'الملف الأصلي حُذف بعد تأكيد واتساب');
  assert.equal(app._test.processedRegistry[path.basename(file)].status, 'sent');
});

test('واتساب مقطوع: الفسح يوضع للموقع فوراً، وعند عودة واتساب يُرسل للقروب بدون تكرار في الموقع', async () => {
  const sent = fakeWhatsApp();
  resetWarehouse({ number: WH_NUMBER, ...SITE });
  const file = newClearanceFile();
  app._test.setWhatsApp({ ready: false, fakeClient: null });
  app._test.queue.push(file);
  try {
    await app.queueWaitingClearancesForSite();
    assert.equal(appOutbox().length, 1, 'وُضع للموقع وواتساب مقطوع');
    assert.ok(fs.existsSync(file), 'الملف ما زال ينتظر واتساب');
    assert.equal(sent.length, 0);
  } finally { app._test.queue.length = 0; }

  const sentAfter = fakeWhatsApp();
  assert.equal(await app.handleInvoice(file), true);
  assert.equal(sentAfter.length, 1);
  assert.equal(sentAfter[0].chatId, WH_GROUP);
  assert.equal(appOutbox().length, 1, 'لم يتكرر في مجلد انتظار الموقع');
});

test('فاتورة تنتظر وواتساب مقطوع لا تذهب للموقع (الفسح فقط)', async () => {
  fakeWhatsApp();
  resetWarehouse({ number: WH_NUMBER, ...SITE });
  const invoice = path.join(process.env.INVOICES_DIR, 'invoice_wait.pdf');
  fs.copyFileSync(path.join(__dirname, 'samples', 'invoice_1001.pdf'), invoice);
  app._test.setWhatsApp({ ready: false, fakeClient: null });
  app._test.queue.push(invoice);
  try {
    await app.queueWaitingClearancesForSite();
    assert.equal(appOutbox().length, 0);
  } finally { app._test.queue.length = 0; }
});

test('فسح بدون رقم عميل مقروء: يذهب للمستودع بعلامة بيانات ناقصة (ليس لمجلد المراجعة)', async () => {
  const sent = fakeWhatsApp();
  resetWarehouse({ number: WH_NUMBER, ...SITE });
  const file = newClearanceFile();
  const r = await app.deliverClearanceToWarehouse(file, app.DOC_TYPES.CLEARANCE, { text: 'بيان فسح جمركي\n', layoutItems: null });
  assert.equal(r.outcome, 'sent');
  assert.equal(sent[0].chatId, WH_GROUP);
  assert.equal(sent[0].fileName, 'فسح.pdf');
  assert.match(sent[0].caption, /رقم العميل غير واضح/);
  const queued = appOutbox();
  assert.equal(queued[0].customer_number, null);
  assert.deepEqual(queued[0].meta_problems, ['customer_number_missing']);
  assert.equal(fs.existsSync(path.join(process.env.INVOICES_DIR, 'Review', 'فسوحات', path.basename(file))), false);
});

test('فسح العميل النقدي (9999): يذهب للمستودع ولا يُحفظ في مجلد "نقدي"', async () => {
  const sent = fakeWhatsApp();
  resetWarehouse({ number: WH_NUMBER, ...SITE });
  const file = newClearanceFile();
  const r = await app.deliverClearanceToWarehouse(file, app.DOC_TYPES.CLEARANCE, { text: 'بيان فسح جمركي\nرقم العميل : 9999\n', layoutItems: null });
  assert.equal(r.outcome, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, WH_GROUP);
  assert.equal(appOutbox()[0].customer_number, '9999');
  assert.equal(fs.existsSync(path.join(process.env.INVOICES_DIR, 'نقدي')), false);
});

test('القروب فقط (بدون موقع): يُرسل لقروب المستودع ولا شيء يوضع للموقع', async () => {
  const sent = fakeWhatsApp();
  resetWarehouse({ number: WH_NUMBER });
  const file = newClearanceFile();
  assert.equal(await app.handleInvoice(file), true);
  assert.equal(sent[0].chatId, WH_GROUP);
  assert.equal(appOutbox().length, 0);
});

test('الموقع فقط (بدون قروب): يوضع للموقع ولا شيء يُرسل عبر واتساب', async () => {
  const sent = fakeWhatsApp();
  resetWarehouse({ ...SITE });
  const file = newClearanceFile();
  assert.equal(await app.handleInvoice(file), false, 'لم تخرج رسالة واتساب');
  assert.equal(sent.length, 0);
  assert.equal(appOutbox().length, 1);
  assert.equal(fs.existsSync(file), false);
});

test('قروب المستودع لم يعد موجوداً: لا إرسال ويذهب للمراجعة، ونسخة الموقع محفوظة', async () => {
  const sent = fakeWhatsApp({ groupExists: false });
  resetWarehouse({ number: WH_NUMBER, ...SITE });
  const file = newClearanceFile();
  assert.equal(await app.handleInvoice(file), false);
  assert.equal(sent.length, 0);
  assert.equal(appOutbox().length, 1);
  const inReview = path.join(process.env.INVOICES_DIR, 'Review', 'فسوحات', path.basename(file));
  assert.ok(fs.existsSync(inReview));
  assert.match(app._test.processedRegistry[path.basename(file)].reason, /قروب المستودع/);

  // بعد إصلاح القروب: زر إعادة الإرسال يرسله لقروب المستودع، والموقع لا يتكرر
  const sentAfter = fakeWhatsApp();
  const retry = await app.retryDocumentSending(inReview);
  assert.equal(retry.success, true, retry.reason);
  assert.equal(sentAfter.length, 1);
  assert.equal(sentAfter[0].chatId, WH_GROUP);
  assert.equal(appOutbox().length, 1);
  assert.equal(fs.existsSync(inReview), false);
});

test('التشغيل التجريبي (dryRun): لا إرسال، لا موقع، والملف في مكانه', async () => {
  const sent = fakeWhatsApp();
  resetWarehouse({ number: WH_NUMBER, ...SITE });
  app.CONFIG.dryRun = true;
  try {
    const file = newClearanceFile();
    assert.equal(await app.handleInvoice(file), false);
    assert.equal(sent.length, 0);
    assert.equal(appOutbox().length, 0);
    assert.ok(fs.existsSync(file));
  } finally { app.CONFIG.dryRun = false; }
});

test('رقم التجربة: يُرسل لرقم التجربة فقط — لا قروب المستودع ولا الموقع', async () => {
  const sent = fakeWhatsApp();
  resetWarehouse({ number: WH_NUMBER, ...SITE });
  app.CONFIG.testPhone = '0500000000';
  try {
    const file = newClearanceFile();
    assert.equal(await app.handleInvoice(file), true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].chatId, /@c\.us$/);
    assert.equal(appOutbox().length, 0);
    assert.ok(fs.existsSync(path.join(process.env.INVOICES_DIR, 'Test', 'فسوحات', path.basename(file))), 'المستند محفوظ في Test');
  } finally { app.CONFIG.testPhone = ''; }
});

test('الفاتورة لا تتأثر: تذهب لقروب العميل ولا تذهب للمستودع', async () => {
  const sent = fakeWhatsApp();
  resetWarehouse({ number: WH_NUMBER, ...SITE });
  const invoice = path.join(process.env.INVOICES_DIR, 'invoice_1001_test.pdf');
  fs.copyFileSync(path.join(__dirname, 'samples', 'invoice_1001.pdf'), invoice);
  assert.equal(await app.handleInvoice(invoice), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, CUSTOMER_GROUP);
  assert.equal(appOutbox().length, 0);
});

test('إعدادات المستودع: رابط غير آمن أو رقم غلط يُرفض ولا يُحفظ، والقروب يُلقى برقمه', () => {
  fakeWhatsApp();
  resetWarehouse({ number: WH_NUMBER, ...SITE });
  assert.throws(() => app.applyWarehouseSettings({ siteUrl: 'http://warehouse.example.com' }), /https/);
  assert.throws(() => app.applyWarehouseSettings({ number: 'مستودع' }), /أرقام بس/);
  assert.throws(() => app.applyWarehouseSettings({ number: '12' }), /قصير/);
  assert.throws(() => app.applyWarehouseSettings({ number: '9999' }), /النقدي/);
  const s = app.getWarehouseSummary();
  assert.equal(s.main.number, WH_NUMBER);
  assert.equal(s.main.groupName, 'مستودع جدة 95123698');
  assert.equal(s.main.problem, '');
  // أرقام عربية تتحول، والرقم اللي ما له قروب يبان سببه
  app.applyWarehouseSettings({ number: '٥٥٥٥٥٥' });
  assert.equal(app.getWarehouseSummary().main.number, '555555');
  assert.match(app.getWarehouseSummary().main.problem, /ما فيه قروب/);
  app.applyWarehouseSettings({ number: WH_NUMBER });
  assert.equal(s.apiKeySet, true);
  assert.equal(JSON.stringify(s).includes('"k"'), false, 'مفتاح الربط لا يرجع للواجهة');
  // مفتاح فاضي = لا تغيير
  app.applyWarehouseSettings({ apiKey: '' });
  assert.equal(app.getWarehouseSummary().apiKeySet, true);
});

test('رقم قروب المستودع ما يُعامل كعميل: الفاتورة برقمه ما تروح لقروب المستودع، والقروب ما ينحسب من العملاء', async () => {
  const sent = fakeWhatsApp();
  resetWarehouse({ number: WH_NUMBER, ...SITE });
  assert.equal(app._test.customerGroupCount(), 1, 'قروب العميل بس — قروب المستودع خارج القائمة');
  const plan = await app._test.planDelivery(WH_NUMBER);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /رقم قروب مستودع وليس رقم عميل/);
  assert.equal(sent.length, 0);
  // بدون رقم مستودع: يرجع قروب عادي في القائمة
  resetWarehouse({ ...SITE });
  assert.equal(app._test.customerGroupCount(), 2);
});

test('أكثر من قروب فيه رقم المستودع: ما يُرسل ويروح للمراجعة بسبب واضح', async () => {
  const sent = fakeWhatsApp();
  app._test.setGroups([...GROUPS, { id: '120363000000000003@g.us', name: 'نسخة مستودع 95123698' }]);
  resetWarehouse({ number: WH_NUMBER, ...SITE });
  const file = newClearanceFile();
  assert.equal(await app.handleInvoice(file), false);
  assert.equal(sent.length, 0);
  assert.match(app._test.processedRegistry[path.basename(file)].reason, /أكثر من قروب/);
  app._test.setGroups(GROUPS);
});

test('اسم العميل من اسم القروب: الكلمات العامة ما تصير اسم ("عميل رقم 0004" => بدون اسم)', () => {
  assert.equal(customerNameFromGroupName('عميل رقم 0004'), '');
  assert.equal(customerNameFromGroupName('قروب العميل 1002'), '');
  assert.equal(customerNameFromGroupName('عميل 4455 - شركة الأمل'), 'شركة الأمل');
  assert.equal(customerNameFromGroupName('ورشة رقم واحد 2040'), 'ورشة رقم واحد');
});
