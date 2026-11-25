/**
 * اختبارات رسائل العميل من موقع المستودع (المرحلة 3) — بدون واتساب حقيقي وبدون إنترنت.
 *  - warehouse-notify.js: السحب، التبليغ بالنتيجة، عدم التكرار، النبضة.
 *  - index.js: الإرسال لقروب العميل بنفس قواعد المطابقة، وضع التجربة، العميل النقدي، الأولوية للمستندات.
 * التشغيل: npm test
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

// سجل البرنامج كثير ويكتب على نفس القناة اللي يستخدمها مشغّل الاختبارات مع هذا الملف،
// فيخلط رسائله أحياناً ("Unable to deserialize cloned data") ويفشل الملف عشوائياً — نسكته هنا.
for (const level of ['log', 'info', 'warn', 'error']) console[level] = () => {};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alwady-notify-'));
process.env.ALWADY_TEST_LOCK = process.env.ALWADY_TEST_LOCK || 'unit-notify';
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
const { WarehouseNotifier } = require('./warehouse-notify');

const quiet = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

/** موقع وهمي: رسائل منتظرة + يسجّل النتائج والنبضات */
async function startFakeSite({ apiKey = 'k' } = {}) {
  const state = { pending: [], acks: [], heartbeats: [], down: false, maxAge: 60, files: {} };
  const server = http.createServer((req, res) => {
    if (state.down) { req.socket.destroy(); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== `Bearer ${apiKey}`) return reply(401, { ok: false });
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const fm = /^\/api\/integration\/notifications\/(\d+)\/attachments\/(\d+)$/.exec(req.url);
      if (req.method === 'GET' && fm) {
        const f = state.files[`${fm[1]}/${fm[2]}`];
        if (!f) return reply(404, { ok: false });
        res.writeHead(200, { 'content-type': f.mime }); return res.end(f.data);
      }
      if (req.method === 'GET' && req.url.startsWith('/api/integration/notifications')) {
        state.notificationPolls = (state.notificationPolls || 0) + 1;
        return reply(200, { ok: true, max_age_minutes: state.maxAge, notifications: state.pending.slice(0, 5) });
      }
      const m = /^\/api\/integration\/notifications\/(\d+)\/ack$/.exec(req.url);
      if (req.method === 'POST' && m) {
        const id = Number(m[1]);
        state.acks.push({ id, ...body });
        state.pending = state.pending.filter(n => n.id !== id);
        return reply(200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/api/integration/heartbeat') {
        state.heartbeats.push(body);
        return reply(200, { ok: true, ...(state.importJob ? { customers_import: state.importJob } : {}) });
      }
      const im = /^\/api\/integration\/customers-import\/([\w-]+)\/(file|result)$/.exec(req.url);
      if (im && im[2] === 'file' && req.method === 'GET') {
        (state.importDownloads = state.importDownloads || []).push(im[1]);
        res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(state.importFile || Buffer.from(''));
      }
      if (im && im[2] === 'result' && req.method === 'POST') {
        (state.importResults = state.importResults || []).push({ id: im[1], ...body });
        return reply(200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/api/integration/customer-report') {
        if (state.noReports) return reply(404, { ok: false });
        (state.reports = state.reports || []).push(body);
        return reply(200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/api/integration/engine/sync') {
        (state.syncs = state.syncs || []).push(body);
        const commands = state.commands || [];
        state.commands = [];
        return reply(200, { ok: true, commands, ...(state.hints ? { hints: state.hints } : {}) });
      }
      reply(404, { ok: false });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

const msg = (id, extra = {}) => ({ id, target: 'customer_group', customer_number: '4001', text: `رسالة ${id}`, created_at: new Date().toISOString(), ...extra });

// ==========================================================
// warehouse-notify.js
// ==========================================================

function newNotifier(site, extra = {}) {
  const queued = [];
  const env = { waReady: true };
  const n = new WarehouseNotifier({
    stateFile: path.join(TMP, `notify-${Math.random().toString(36).slice(2)}.json`),
    getConfig: () => ({ siteUrl: site.url, apiKey: 'k' }),
    isWhatsAppReady: () => env.waReady,
    hasQueuedMessages: () => queued.length > 0,
    enqueueMessage: (m) => queued.push(m),
    getOutboxPending: () => 3,
    log: quiet,
    pollMs: 60000,
    heartbeatMs: 60000,
    ...extra
  });
  return { n, queued, env };
}

test('السحب: يجيب الرسائل المنتظرة ويحطها في طابور البرنامج مع مدة صلاحيتها', async () => {
  const site = await startFakeSite();
  const { n, queued } = newNotifier(site);
  try {
    site.state.pending = [msg(1), msg(2)];
    site.state.maxAge = 45;
    await n.poll();
    assert.deepEqual(queued.map(m => m.id), [1, 2]);
    assert.equal(queued[0].max_age_minutes, 45);
    // عندنا رسائل ما خلصت: ما يسحب زيادة
    site.state.pending.push(msg(3));
    await n.poll();
    assert.equal(queued.length, 2);
  } finally { n.stop(); await site.close(); }
});

test('واتساب مقطوع: ما يسحب شيء (الرسائل تبقى في الموقع)', async () => {
  const site = await startFakeSite();
  const { n, queued, env } = newNotifier(site);
  try {
    env.waReady = false;
    site.state.pending = [msg(1)];
    await n.poll();
    assert.equal(queued.length, 0);
    assert.equal(site.state.acks.length, 0);
  } finally { n.stop(); await site.close(); }
});

test('ما تتكرر رسالة: اللي انرسلت تنحفظ، ولو رجع الموقع يعرضها نبلّغه بدون إرسال', async () => {
  const site = await startFakeSite();
  const { n, queued } = newNotifier(site);
  try {
    site.state.down = true;
    await n.ack(7, 'sent', 'قروب: مؤسسة 4001'); // الموقع طافي وقت التبليغ
    assert.equal(n.status().pendingAcks, 1);
    assert.equal(n.wasSent(7), true);

    // البرنامج انقفل وانفتح: الحالة من الملف
    const again = new WarehouseNotifier({ ...n, stateFile: n.stateFile, getConfig: n.getConfig, isWhatsAppReady: () => true, hasQueuedMessages: () => queued.length > 0, enqueueMessage: (m) => queued.push(m), log: quiet });
    assert.equal(again.wasSent(7), true);

    site.state.down = false;
    site.state.pending = [msg(7)]; // الموقع ما وصله التبليغ فيعرضها مرة ثانية
    await again.poll();
    assert.equal(queued.length, 0, 'ما دخلت الطابور');
    assert.deepEqual(site.state.acks.map(a => [a.id, a.result]), [[7, 'sent'], [7, 'sent']].slice(0, site.state.acks.length));
    assert.ok(site.state.acks.every(a => a.id === 7 && a.result === 'sent'));
    assert.equal(again.status().pendingAcks, 0);
  } finally { n.stop(); await site.close(); }
});

test('النبضة: حالة واتساب + كم فسح ينتظر الرفع', async () => {
  const site = await startFakeSite();
  const { n, env } = newNotifier(site);
  try {
    await n.heartbeat();
    env.waReady = false;
    await n.heartbeat();
    assert.deepEqual(site.state.heartbeats.map(h => [h.whatsapp, h.outbox_pending]), [['connected', 3], ['down', 3]]);
  } finally { n.stop(); await site.close(); }
});

test('تقرير العملاء للموقع: ينرسل مع النبضة بس لما يتغير، والموقع القديم (404) ما ينزعج كل دقيقة', async () => {
  const site = await startFakeSite();
  let snap = { customers: [{ number: '0004' }], records: [], groups: {} };
  const { n } = newNotifier(site, { getReportSnapshot: () => snap });
  try {
    await n.heartbeat();
    await n.heartbeat();
    assert.equal((site.state.reports || []).length, 1, 'نفس البيانات ما تنعاد');
    snap = { ...snap, records: [{ customer: '0004', type: 'invoice', status: 'sent', at: new Date().toISOString() }] };
    await n.heartbeat();
    assert.equal(site.state.reports.length, 2, 'تغيّرت => تنرسل');
    assert.equal(site.state.reports[1].records[0].customer, '0004');

    site.state.noReports = true;
    snap = { ...snap, groups: { 4: 'عميل 0004' } };
    await n.heartbeat();
    snap = { ...snap, groups: { 4: 'عميل رقم 0004' } };
    await n.heartbeat();
    assert.equal(site.state.reports.length, 2);
    assert.ok(n.reportPausedUntil > Date.now(), 'موقع ما يعرف الطلب: يتوقف نص ساعة');
    assert.equal(site.state.heartbeats.length, 5, 'النبضة نفسها ما تتأثر');
  } finally { n.stop(); await site.close(); }
});

test('قائمة العملاء من الموقع: ينزّل الملف مع النبضة، البرنامج يقرأه، والنتيجة ترجع للموقع — والملف ما ينقرأ مرتين', async () => {
  const site = await startFakeSite();
  const seen = [];
  const { n } = newNotifier(site, {
    onCustomersImport: async (buf, job) => { seen.push({ text: buf.toString('utf8'), job }); return { ok: true, count: 2 }; }
  });
  try {
    site.state.importJob = { id: 'imp1', name: 'العملاء.csv', force: false };
    site.state.importFile = Buffer.from('customer_no\n0004\n1001\n');
    await n.heartbeat();
    assert.equal(seen.length, 1);
    assert.match(seen[0].text, /0004/);
    assert.equal(seen[0].job.name, 'العملاء.csv');
    assert.deepEqual(site.state.importResults.map(r => [r.id, r.ok, r.count]), [['imp1', true, 2]]);
    // الموقع ما وصلته النتيجة ويعرض نفس الملف: ما ينقرأ مرة ثانية، النتيجة بس تنعاد
    await n.heartbeat();
    assert.equal(seen.length, 1);
    assert.equal(site.state.importDownloads.length, 1);
    assert.equal(site.state.importResults.length, 2);
  } finally { n.stop(); await site.close(); }
});

test('بدون إعدادات الموقع: ما يتصل بشيء', async () => {
  let calls = 0;
  const n = new WarehouseNotifier({
    stateFile: path.join(TMP, 'notify-none.json'), getConfig: () => ({ siteUrl: '', apiKey: '' }),
    isWhatsAppReady: () => true, hasQueuedMessages: () => false, enqueueMessage: () => {}, log: quiet,
    fetchImpl: async () => { calls++; throw new Error('no'); }
  });
  await n.poll();
  await n.heartbeat();
  await n.ack(1, 'sent');
  assert.equal(calls, 0);
});


test('رسالة تنتظر تأكيد واتساب وانسحبت مرة ثانية من الموقع => ما تدخل الطابور مرة ثانية', async () => {
  const site = await startFakeSite();
  const { n, queued } = newNotifier(site);
  try {
    n.markAttempt(11); // طلعت لواتساب وتنتظر التأكيد (والطابور فاضي)
    site.state.pending = [msg(11)];
    await n.poll();
    assert.equal(queued.length, 0, 'ما تنضاف نسخة ثانية');
    assert.equal(site.state.acks.length, 0, 'ولا تنسجّل نتيجة قبل ما يخلص الإرسال الأول');
    // الإرسال الأول خلص بدون تأكيد: النتيجة "ما أُرسلت"، ولو عرضها الموقع مرة ثانية ما تنعاد
    await n.ack(11, 'failed', 'خرجت لكن ما وصل تأكيد');
    site.state.pending = [msg(11)];
    await n.poll();
    assert.equal(queued.length, 0, 'ما تنعاد أبداً');
    assert.equal(n.wasAttempted(11), true);
  } finally { n.stop(); await site.close(); }
});

test('البرنامج طفى في نص إرسال رسالة => بعد التشغيل ما تنعاد (تنسجّل ما أُرسلت مع السبب)', async () => {
  const site = await startFakeSite();
  const { n } = newNotifier(site);
  try {
    n.markAttempt(12);
    // تشغيل جديد بنفس ملف الحالة
    const queued = [];
    const again = new WarehouseNotifier({ stateFile: n.stateFile, getConfig: n.getConfig, isWhatsAppReady: () => true, hasQueuedMessages: () => queued.length > 0, enqueueMessage: (m) => queued.push(m), log: quiet, pollMs: 60000, heartbeatMs: 60000 });
    site.state.pending = [msg(12)];
    await again.poll();
    assert.equal(queued.length, 0);
    assert.deepEqual(site.state.acks.map(a => [a.id, a.result]), [[12, 'failed']]);
    assert.match(site.state.acks[0].reason, /ما تنعاد/);
    again.stop();
  } finally { n.stop(); await site.close(); }
});

test('واتساب انقطع قبل ما تطلع الرسالة => ترجع طبيعية وتنرسل بعدين', async () => {
  const site = await startFakeSite();
  const { n, queued } = newNotifier(site);
  try {
    n.markAttempt(13);
    n.clearAttempt(13); // ما طلع شيء
    site.state.pending = [msg(13)];
    await n.poll();
    assert.deepEqual(queued.map(m => m.id), [13]);
  } finally { n.stop(); await site.close(); }
});

// ==========================================================
// index.js: الإرسال الفعلي
// ==========================================================

const app = require('./index');
const { MessageMedia } = require('./wa-baileys');

const CUSTOMER_GROUP = '120363000000000011@g.us';
const OTHER_GROUP = '120363000000000012@g.us';
const GROUPS = [
  { id: CUSTOMER_GROUP, name: 'مؤسسة النخبة 4001' },
  { id: OTHER_GROUP, name: 'مؤسسة النخبة 1001' }
];

function fakeWhatsApp({ failWith = null } = {}) {
  const sent = [];
  const fakeClient = {
    async getChatById(id) { const g = GROUPS.find(x => x.id === id); return g ? { isGroup: true, id: { _serialized: g.id }, name: g.name } : null; },
    async getNumberId(phone) { return { _serialized: `${phone}@c.us` }; },
    async sendMessage(chatId, content, options) {
      if (failWith) throw failWith;
      sent.push({ chatId, content: typeof content === 'string' ? content : `[ملف] ${content.filename}`, caption: options && options.caption });
      return { ack: true };
    }
  };
  app._test.setWhatsApp({ ready: true, fakeClient, media: MessageMedia });
  app._test.setGroups(GROUPS);
  return sent;
}

let site;
test.before(async () => {
  site = await startFakeSite();
  app.applyWarehouseSettings({ siteUrl: site.url, apiKey: 'k' });
});
test.after(async () => { app.warehouseNotifier().stop(); if (site) await site.close(); });

function reset() {
  site.state.acks.length = 0;
  site.state.pending.length = 0;
  app.CONFIG.dryRun = false;
  app.CONFIG.testPhone = '';
  app.CONFIG.delayMs = 0;
  app._test.messageQueue.length = 0;
}

let nextId = 100;
const deliver = (extra) => app.deliverCustomerMessage({ ...msg(++nextId, extra), max_age_minutes: 60 });
const lastAck = () => site.state.acks[site.state.acks.length - 1];

test('الرسالة تروح لقروب العميل الصحيح (نفس قواعد المطابقة) والموقع يتبلّغ "أُرسلت"', async () => {
  reset();
  const sent = fakeWhatsApp();
  assert.equal(await deliver({ customer_number: '4001', text: 'السلام عليكم، طلبكم قيد التجهيز في المستودع.' }), true);
  assert.deepEqual(sent, [{ chatId: CUSTOMER_GROUP, content: 'السلام عليكم، طلبكم قيد التجهيز في المستودع.', caption: undefined }]);
  assert.equal(lastAck().result, 'sent');
  assert.match(lastAck().reason, /مؤسسة النخبة 4001/);
});

test('ما فيه قروب للعميل: ما تنرسل والموقع يعرف السبب', async () => {
  reset();
  const sent = fakeWhatsApp();
  assert.equal(await deliver({ customer_number: '7777' }), false);
  assert.equal(sent.length, 0);
  assert.equal(lastAck().result, 'failed');
  assert.match(lastAck().reason, /7777/);
});

test('العميل النقدي (9999) أو بدون رقم: ما تنرسل', async () => {
  reset();
  const sent = fakeWhatsApp();
  await deliver({ customer_number: '9999' });
  assert.equal(lastAck().result, 'skipped');
  assert.match(lastAck().reason, /نقدي/);
  await deliver({ customer_number: null });
  assert.equal(lastAck().result, 'skipped');
  assert.equal(sent.length, 0);
});

test('التشغيل التجريبي: ما يرسل شيء، والموقع يعرف وين كان بيروح', async () => {
  reset();
  const sent = fakeWhatsApp();
  app.CONFIG.dryRun = true;
  await deliver({ customer_number: '4001' });
  assert.equal(sent.length, 0);
  assert.equal(lastAck().result, 'skipped');
  assert.match(lastAck().reason, /تشغيل تجريبي.*مؤسسة النخبة 4001/);
});

test('رقم التجربة: الرسالة تروح لرقم التجربة بدل قروب العميل', async () => {
  reset();
  const sent = fakeWhatsApp();
  app.CONFIG.testPhone = '0500000000';
  await deliver({ customer_number: '4001' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].chatId, /@c\.us$/);
  assert.match(lastAck().reason, /رقم التجربة/);
});

test('رسالة أقدم من مدتها: تنلغي بدون إرسال', async () => {
  reset();
  const sent = fakeWhatsApp();
  await deliver({ created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
  assert.equal(sent.length, 0);
  assert.equal(lastAck().result, 'expired');
});

test('واتساب انقطع قبل الإرسال: ترجع للطابور بدون تبليغ (وتنرسل بعدين)', async () => {
  reset();
  const err = new Error('واتساب غير متصل'); err.code = 'WA_NOT_READY';
  fakeWhatsApp({ failWith: err });
  assert.equal(await deliver({ customer_number: '4001' }), 'requeue');
  assert.equal(site.state.acks.length, 0);
});

test('الأولوية للمستندات: فاتورة وصلت مع رسالة عميل => الفاتورة تنرسل أول', async () => {
  reset();
  const sent = fakeWhatsApp();
  const invoice = path.join(process.env.INVOICES_DIR, 'invoice_priority.pdf');
  fs.copyFileSync(path.join(__dirname, 'samples', 'invoice_1001.pdf'), invoice);
  app._test.messageQueue.push({ ...msg(++nextId, { customer_number: '4001', text: 'رسالة عميل' }), max_age_minutes: 60 });
  app._test.queue.push(path.resolve(invoice));
  await app.processQueue();
  for (let i = 0; i < 40 && sent.length < 2; i++) await sleep(50);
  assert.equal(sent.length, 2);
  assert.match(sent[0].content, /^\[ملف\]/, 'المستند أول');
  assert.equal(sent[0].chatId, OTHER_GROUP);
  assert.equal(sent[1].content, 'رسالة عميل');
  assert.equal(sent[1].chatId, CUSTOMER_GROUP);
});

test('الطريق كامل: البرنامج يسحب من الموقع ويرسل ويبلّغ', async () => {
  reset();
  const sent = fakeWhatsApp();
  site.state.pending = [msg(++nextId, { customer_number: '4001', text: 'السلام عليكم، تم شحن طلبكم.' })];
  await app.warehouseNotifier().poll();
  for (let i = 0; i < 40 && site.state.acks.length < 1; i++) await sleep(50);
  assert.deepEqual(sent.map(s => [s.chatId, s.content]), [[CUSTOMER_GROUP, 'السلام عليكم، تم شحن طلبكم.']]);
  assert.equal(lastAck().result, 'sent');
  assert.equal(site.state.pending.length, 0);
});

test('رسالة طلعت بدون تأكيد من واتساب ثم انسحبت مرة ثانية => ما تنرسل للعميل مرتين', async () => {
  reset();
  const sent = [];
  const fakeClient = {
    async getChatById(id) { const g = GROUPS.find(x => x.id === id); return g ? { isGroup: true, id: { _serialized: g.id }, name: g.name } : null; },
    async sendMessage(chatId, content) { sent.push({ chatId, content }); return { ack: false }; } // خرجت وما وصل تأكيد
  };
  app._test.setWhatsApp({ ready: true, fakeClient, media: MessageMedia });
  app._test.setGroups(GROUPS);
  const m = { ...msg(++nextId, { customer_number: '4001' }), max_age_minutes: 60 };
  await app.deliverCustomerMessage(m);
  assert.equal(sent.length, 1);
  assert.equal(lastAck().result, 'failed');
  await app.deliverCustomerMessage(m); // نسخة ثانية من نفس الرسالة
  assert.equal(sent.length, 1, 'ما تطلع مرة ثانية');
  assert.match(lastAck().reason, /ما تنعاد/);
});

test('واتساب انقطع قبل ما تطلع الرسالة => ترجع للطابور وتنرسل عادي بعد الرجوع', async () => {
  reset();
  const notReady = Object.assign(new Error('not ready'), { code: 'WA_NOT_READY' });
  fakeWhatsApp({ failWith: notReady });
  const m = { ...msg(++nextId, { customer_number: '4001' }), max_age_minutes: 60 };
  assert.equal(await app.deliverCustomerMessage(m), 'requeue');
  const sent = fakeWhatsApp();
  assert.equal(await app.deliverCustomerMessage(m), true);
  assert.equal(sent.length, 1);
  assert.equal(lastAck().result, 'sent');
});

test('سند التسليم: ينحمّل من الموقع وينرسل مع نص رسالة الشحن (أول مرفق مع النص، والثاني بدون)', async () => {
  reset();
  const sent = fakeWhatsApp();
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(50, 1)]);
  const pdf = Buffer.from('%PDF-1.4 test receipt');
  const id = ++nextId;
  site.state.files[`${id}/7`] = { mime: 'image/jpeg', data: jpg };
  site.state.files[`${id}/8`] = { mime: 'application/pdf', data: pdf };
  const r = await app.deliverCustomerMessage({ ...msg(id, { text: 'السلام عليكم، تم شحن طلبكم رقم 1911620.' }), max_age_minutes: 60, attachments: [{ id: 7, mime: 'image/jpeg' }, { id: 8, mime: 'application/pdf' }] });
  assert.equal(r, true);
  assert.equal(sent.length, 2);
  assert.match(sent[0].content, /سند التسليم 1.jpeg/);
  assert.equal(sent[0].caption, 'السلام عليكم، تم شحن طلبكم رقم 1911620.');
  assert.match(sent[1].content, /سند التسليم 2.pdf/);
  assert.equal(sent[1].caption, undefined);
  assert.equal(lastAck().result, 'sent');

  // السند انحذف من الموقع: ما يطلع شي، والموقع يعرف السبب
  const id2 = ++nextId;
  const before = sent.length;
  assert.equal(await app.deliverCustomerMessage({ ...msg(id2), max_age_minutes: 60, attachments: [{ id: 9, mime: 'image/jpeg' }] }), false);
  assert.equal(sent.length, before, 'ما انرسل شي');
  assert.equal(lastAck().result, 'failed');
  assert.match(lastAck().reason, /السند/);
});

test('قائمة العملاء من الموقع على خطوتين: قراءة بس (بدون تغيير) ثم الحفظ بعد موافقة الإدارة', async () => {
  const { importCustomersFromSite, customerReportSnapshot } = app._test;
  const before = (customerReportSnapshot() || { customers: [] }).customers.length;
  const csv = Buffer.from('customer_no,rep_code,rep_name\n0004,7,اديب\n1001,8,سالم\n', 'utf8');
  const parsed = await importCustomersFromSite(csv, { id: 'p1', mode: 'parse', name: 'العملاء.csv' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.customers.map(c => c.number), ['0004', '1001']);
  assert.equal((customerReportSnapshot() || { customers: [] }).customers.length, before, 'القراءة ما تغيّر القائمة');

  const applied = await importCustomersFromSite(Buffer.from(JSON.stringify({ customers: parsed.customers })), { id: 'a1', mode: 'apply', name: 'العملاء.csv' });
  assert.deepEqual(applied, { ok: true, count: 2 });
  assert.deepEqual(customerReportSnapshot().customers.map(c => c.number), ['0004', '1001']);

  const bad = await importCustomersFromSite(Buffer.from('no numbers here'), { id: 'p2', mode: 'parse' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /customer_no/);
});

test('صفحات واتساب في الموقع: البرنامج يرسل حالته لما تتغير، ينفذ أوامر الإدارة ويرجّع النتيجة، والأمر ما يتنفذ مرتين', async () => {
  const site = await startFakeSite();
  let st = { status: { status: 'connected' }, logs: [{ id: 'l1' }] };
  const ran = [];
  const { n } = newNotifier(site, {
    getEngineState: async () => st,
    runCommand: async (c) => { ran.push(c); return { status: 200, json: { success: true, echo: c.path } }; }
  });
  try {
    await n.syncRemote();
    assert.equal(site.state.syncs.length, 1);
    assert.deepEqual(site.state.syncs[0].state, st, 'أول مرة: الحالة كاملة');
    await n.syncRemote();
    assert.equal(site.state.syncs[1].state, undefined, 'ما تغيّرت: بدون الحالة');

    // أمر من الإدارة: ينفذ، والنتيجة ترجع على طول مع الحالة الجديدة
    site.state.commands = [{ id: 7, method: 'POST', path: '/api/cash-done', body: { filePath: 'x.pdf' } }];
    await n.syncRemote();
    assert.equal(ran.length, 1);
    assert.equal(ran[0].path, '/api/cash-done');
    const withResult = site.state.syncs.find(s => s.results && s.results.length);
    assert.deepEqual(withResult.results[0], { id: 7, status: 200, json: { success: true, echo: '/api/cash-done' } });

    // نفس الأمر لو رجع (الموقع ما وصلته النتيجة): ما يتنفذ مرة ثانية
    site.state.commands = [{ id: 7, method: 'POST', path: '/api/cash-done', body: {} }];
    await n.syncRemote();
    assert.equal(ran.length, 1);

    // الحالة تغيّرت => تنرسل
    st = { ...st, logs: [{ id: 'l2' }, { id: 'l1' }] };
    const before = site.state.syncs.length;
    await n.syncRemote();
    assert.deepEqual(site.state.syncs[before].state.logs.map(l => l.id), ['l2', 'l1']);
  } finally { n.stop(); await site.close(); }
});

test('أوامر الموقع: بس الأوامر المسموحة تتنفذ', async () => {
  const r = await app._test.runRemoteCommand({ method: 'POST', path: '/api/logout' });
  assert.equal(r.status, 403);
  const r2 = await app._test.runRemoteCommand({ method: 'DELETE', path: '/api/settings' });
  assert.equal(r2.status, 403);
});

test('تغيّر عنوان الموقع: ذاكرة الرسائل المرسلة تنمسح (أرقام الموقع الجديد تبدأ من 1 وما تنحسب "أُرسلت من قبل")', async () => {
  const siteA = await startFakeSite();
  const siteB = await startFakeSite();
  const queued = [];
  let current = siteA;
  const stateFile = path.join(TMP, 'notify-site-change.json');
  const make = () => new WarehouseNotifier({
    stateFile, getConfig: () => ({ siteUrl: current.url, apiKey: 'k' }), isWhatsAppReady: () => true,
    hasQueuedMessages: () => false, enqueueMessage: (m) => queued.push(m), log: quiet, pollMs: 60000, heartbeatMs: 60000
  });
  try {
    const a = make();
    await a.ack(1, 'sent', 'قروب: x');
    assert.equal(a.wasSent(1), true);
    // نفس الموقع بعد إعادة التشغيل: الذاكرة باقية
    assert.equal(make().wasSent(1), true);
    // موقع ثاني: الرسالة رقم 1 هناك رسالة جديدة لازم تنرسل
    current = siteB;
    const b = make();
    assert.equal(b.wasSent(1), false);
    siteB.state.pending = [msg(1)];
    await b.poll();
    assert.deepEqual(queued.map(m => m.id), [1], 'دخلت طابور الإرسال');
    assert.equal(siteB.state.acks.length, 0, 'ما انبلّغ الموقع إنها "أُرسلت من قبل"');
  } finally { await siteA.close(); await siteB.close(); }
});

test('تلميحات الموقع: ما يسأل عن الرسائل على الفاضي، ويسأل أول ما الموقع يقول فيه رسالة', async () => {
  const site = await startFakeSite();
  const { n, queued } = newNotifier(site, { getEngineState: async () => ({ status: { status: 'connected' } }) });
  try {
    // بدون تلميحات (موقع قديم): يسأل كل مرة مثل قبل
    await n.poll();
    assert.equal(site.state.notificationPolls, 1);

    // الموقع يقول ما فيه شي: السؤال يتوقف (إلا مرة كل دقيقتين احتياط)
    site.state.hints = { notifications: false, relay: false };
    await n.syncRemote();
    await n.poll(); // الاحتياط الأول
    await n.poll();
    await n.poll();
    assert.equal(site.state.notificationPolls, 2, 'سؤال احتياط واحد بس');
    assert.equal(n.shouldPoll('relay'), true, 'احتياط الفروع الأول');
    assert.equal(n.shouldPoll('relay'), false);

    // الموقع يقول فيه رسالة: يسحبها
    site.state.hints = { notifications: true, relay: true };
    site.state.pending = [msg(5)];
    await n.syncRemote();
    await n.poll();
    assert.deepEqual(queued.map(m => m.id), [5]);
    assert.equal(n.shouldPoll('relay'), true);
  } finally { n.stop(); await site.close(); }
});
